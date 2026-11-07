"""bj report --format gdoc: the DOCX report uploaded to Google Drive as a Google Doc, which a rerun updates in place."""

import json
import os
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Any

from google.auth.exceptions import RefreshError, TransportError
from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload
from httplib2 import HttpLib2Error

from pipeline.cli import BadInput
from pipeline.cli.report import Report, write_docx

# drive.file reaches only the files this client creates, which is all bj needs.
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
GOOGLE_DOC = "application/vnd.google-apps.document"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FIELDS = "id,webViewLink"
TOKEN = Path.home() / ".config" / "blockjuice" / "google-token.json"
SETUP = (
    "--format gdoc needs Google credentials. In a Google Cloud project, enable the Google Drive API, create "
    "an OAuth client ID of type Desktop app, download its JSON and set GOOGLE_OAUTH_CLIENT_SECRET to its path. "
    "Or set GOOGLE_APPLICATION_CREDENTIALS to a service account key."
)


def one_line(value: object) -> str:
    """value as text with each run of whitespace, newlines included, as one space. A refused refresh can carry
    the body of an HTML page, and main prints a BadInput as one line."""
    return " ".join(str(value).split())


def unreachable(error: Exception) -> BadInput:
    return BadInput(f"Could not reach Google: {one_line(error)}")


def user_credentials(client_secret: Path) -> Credentials:
    """The cached token, refreshed when it has expired. The first time, or when Google refuses the refresh,
    the browser asks the user for consent. The new token goes to the cache."""
    if not client_secret.is_file():
        raise BadInput(f"GOOGLE_OAUTH_CLIENT_SECRET is {client_secret}, which does not exist")
    try:
        credentials = Credentials.from_authorized_user_file(TOKEN, SCOPES) if TOKEN.is_file() else None
    except ValueError as error:
        raise BadInput(f"{TOKEN} is not a Google token ({one_line(error)}): delete it to sign in again") from None
    if credentials and credentials.expired and credentials.refresh_token:
        try:
            credentials.refresh(Request())
        except RefreshError:
            credentials = None
        except TransportError as error:
            raise unreachable(error) from None
    if not (credentials and credentials.valid):
        try:
            flow = InstalledAppFlow.from_client_secrets_file(client_secret, SCOPES)
        except ValueError as error:
            raise BadInput(f"GOOGLE_OAUTH_CLIENT_SECRET: {error}") from None
        credentials = flow.run_local_server(port=0)
    save_token(credentials)
    return credentials


def save_token(credentials: Credentials) -> None:
    """Writes credentials to TOKEN with mode 600. The write goes to a temporary file that then replaces TOKEN,
    so a write that fails partway leaves the old token whole."""
    TOKEN.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=TOKEN.parent, prefix=f".{TOKEN.name}.")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(credentials.to_json())
        os.replace(temporary, TOKEN)
    except BaseException:
        os.unlink(temporary)
        raise


def connect() -> Any:
    """A Drive v3 client from GOOGLE_OAUTH_CLIENT_SECRET, or else GOOGLE_APPLICATION_CREDENTIALS."""
    if client_secret := os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET"):
        credentials = user_credentials(Path(client_secret).expanduser())
    elif key := os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        if not Path(key).is_file():
            raise BadInput(f"GOOGLE_APPLICATION_CREDENTIALS is {key}, which does not exist")
        try:
            credentials = service_account.Credentials.from_service_account_file(key, scopes=SCOPES)
        except ValueError as error:
            raise BadInput(f"GOOGLE_APPLICATION_CREDENTIALS is not a service account key: {error}") from None
    else:
        raise BadInput(SETUP)
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def in_drive(files: Any, doc_id: str) -> bool:
    """Whether Drive still has the Doc outside the trash. A Doc this client cannot see reads as not found."""
    try:
        return not files.get(fileId=doc_id, fields="trashed", supportsAllDrives=True).execute()["trashed"]
    except HttpError as error:
        if error.status_code == 404:
            return False
        raise


def recorded_id(record: Path) -> str | None:
    """The id of the Doc that record names, or None when there is no record yet."""
    if not record.is_file():
        return None
    try:
        doc_id = json.loads(record.read_text())["id"]
    except (ValueError, KeyError, TypeError):
        doc_id = None
    if not (isinstance(doc_id, str) and doc_id):
        raise BadInput(f"{record} does not hold a Doc id: fix it, or delete it to create a new Doc")
    return doc_id


def publish(report: Report, record: Path) -> str:
    """Uploads the report as a Google Doc and writes record as {"id", "url"}. When record names a Doc that
    Drive still has, the upload replaces its content. Otherwise it creates a Doc, in GOOGLE_DRIVE_FOLDER_ID
    when that is set. Returns "created <url>" or "updated <url>"."""
    doc_id = recorded_id(record)
    files = connect().files()
    docx = BytesIO()
    write_docx(report, docx)
    media = MediaIoBaseUpload(docx, mimetype=DOCX)
    try:
        if doc_id and in_drive(files, doc_id):
            action = "updated"
            doc = files.update(fileId=doc_id, media_body=media, fields=FIELDS, supportsAllDrives=True).execute()
        else:
            action = "created"
            body = {"name": report.answer["question"], "mimeType": GOOGLE_DOC}
            if folder := os.environ.get("GOOGLE_DRIVE_FOLDER_ID"):
                body["parents"] = [folder]
            doc = files.create(body=body, media_body=media, fields=FIELDS, supportsAllDrives=True).execute()
    except HttpError as error:
        raise BadInput(f"Google Drive refused the upload: {error.status_code} {error.reason}") from None
    except RefreshError as error:
        # The client refreshes the token inside execute, and Google refuses a revoked grant or a deleted key.
        raise BadInput(
            f"Google refused the credentials ({one_line(error.args[0])}): delete {TOKEN} to sign in again, "
            "or set GOOGLE_APPLICATION_CREDENTIALS to a new service account key"
        ) from None
    except (TransportError, HttpLib2Error, OSError) as error:
        # TransportError comes from the token refresh, HttpLib2Error and OSError from the Drive request.
        raise unreachable(error) from None
    record.parent.mkdir(exist_ok=True)
    record.write_text(json.dumps({"id": doc["id"], "url": doc["webViewLink"]}, indent=2) + "\n")
    return f"{action} {doc['webViewLink']}"
