import io
import json
import re
import subprocess
import sys
import zipfile
import zlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import docx
import httplib2
import openpyxl
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from docx.table import Table
from google.auth.exceptions import RefreshError, TransportError
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.errors import HttpError
from httplib2 import ServerNotFoundError

from pipeline.cli import BadInput, check, gdoc, main
from pipeline.cli.report import cell_value, run

BALANCE = "1234567890123456789012345"
ADDRESS = "0x00000000219ab540356cBB839Cbe05303d7705Fa"
LONG_NAME = "balances_of_every_wallet_by_asset_and_chain"

ANSWER = {
    "question": "Which wallets hold the most ETH — and how much?",
    "slug": "top-wallets",
    "answered_at": "2026-11-04T19:00:00Z",
    "value": None,
    "definitions": {"wallet": "An address in addresses.json → one row per asset."},
    "alternatives": [],
    "window": {},
    "results": [
        {"analysis": "top_wallets", "path": "results/top_wallets.csv", "columns": ["wallet", "balance", "share"], "rows": 2, "sql": "select 1"},
        {"analysis": LONG_NAME, "path": f"results/{LONG_NAME}.csv", "columns": ["n"], "rows": 60, "sql": "select 2"},
    ],
    "inputs": [
        {
            "source": "ethereum.eth_balances",
            "raw_table": "raw.ethereum_eth_balances",
            "last_run": {"finished_at": "2026-11-04T06:00:00Z", "records_written": 12, "dagster_run_id": "run-1"},
            "dead_letters": {"pending": 0, "parked": 1},
        }
    ],
    "checks": [
        {"name": "dbt_tests", "status": "passed", "detail": "54 passed"},
        {"name": "dead_letters", "status": "failed", "detail": "ethereum.eth_balances 0 pending, 1 parked"},
        {"name": "freshness", "status": "passed", "detail": "ethereum.eth_balances finished 2026-11-04T06:00:00Z"},
    ],
    "provenance": {"git_sha": "abc123", "git_dirty": False, "dbt_version": "1.12.6"},
}

ANSWER_MD = """# Top wallets

The largest wallet holds **1.23 million ETH** — “the deposit contract”.

- It leads by a wide margin…
- Values are in wei ≈ 10⁻¹⁸ ETH.

| wallet | note |
|---|---|
| deposit | ✓ checked |
"""


@pytest.fixture
def answered(tmp_path):
    folder = tmp_path / "answers" / "top-wallets"
    (folder / "results").mkdir(parents=True)
    (folder / "answer.json").write_text(json.dumps(ANSWER))
    (folder / "answer.md").write_text(ANSWER_MD)
    (folder / "results" / "top_wallets.csv").write_text(f"wallet,balance,share\n{ADDRESS},{BALANCE},0.25\nx,,007\n")
    (folder / "results" / f"{LONG_NAME}.csv").write_text("n\n" + "".join(f"{i}\n" for i in range(60)))
    return tmp_path, folder


def test_xlsx_has_the_answer_sheet_and_one_sheet_per_result(answered):
    root, folder = answered
    assert run(root, "top-wallets", "xlsx") == 0
    book = openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx")
    assert book.sheetnames == ["Answer", "top_wallets", LONG_NAME[:31]]

    summary = book["Answer"]
    assert summary["A1"].value == "Question"
    assert summary["B1"].value == ANSWER["question"]
    assert summary["A3"].value == "Answered at"
    column_a = [cell.value for cell in summary["A"]]
    assert "The largest wallet holds **1.23 million ETH** — “the deposit contract”." in column_a
    assert {"Answer", "Definitions", "Checks", "Inputs", "Provenance"} <= set(column_a)
    assert ["dead_letters", "failed", "ethereum.eth_balances 0 pending, 1 parked"] in [
        [cell.value for cell in row[:3]] for row in summary.iter_rows()
    ]

    top = book["top_wallets"]
    assert [cell.value for cell in top[1]] == ["wallet", "balance", "share"]
    assert top["A1"].font.bold
    assert top.freeze_panes == "A2"
    assert top["B2"].value == BALANCE
    assert top["B2"].data_type == "s"
    assert top["C2"].value == 0.25
    assert top["A2"].value == ADDRESS
    assert top["B3"].value is None
    assert top["C3"].value == "007"
    assert book[LONG_NAME[:31]]["A61"].value == 59
    assert not (folder / "reports" / "top-wallets.pdf").exists()


def test_pdf_is_a_pdf_with_pages(answered):
    root, folder = answered
    assert run(root, "top-wallets", "pdf") == 0
    data = (folder / "reports" / "top-wallets.pdf").read_bytes()
    assert data.startswith(b"%PDF")
    assert len(re.findall(rb"/Type /Page\b", data)) >= 1


def page_text(pdf: bytes) -> bytes:
    """The PDF's page content streams, which fpdf2 compresses, inflated and joined."""
    return b"".join(zlib.decompress(stream) for stream in re.findall(rb"stream\n(.*?)\nendstream", pdf, re.S))


def test_a_check_added_with_bj_check_shows_with_the_others(answered):
    root, folder = answered
    assert check.run(root, "top-wallets", "cross_check", "passed", "Etherscan lists the same top 2 wallets") == 0
    assert run(root, "top-wallets") == 0

    summary = openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx")["Answer"]
    rows = [[cell.value for cell in row[:3]] for row in summary.iter_rows()]
    checks = rows.index(["Check", "Status", "Detail"])
    assert rows[checks + 4] == ["cross_check", "passed", "Etherscan lists the same top 2 wallets"]
    text = page_text((folder / "reports" / "top-wallets.pdf").read_bytes())
    assert b"(cross_check)" in text
    assert b"(Etherscan lists the same top 2 wallets)" in text


def test_both_formats_by_default_overwriting_old_reports(answered, monkeypatch):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    (folder / "reports").mkdir()
    (folder / "reports" / "top-wallets.xlsx").write_text("not a workbook")
    assert main(["report", "top-wallets"]) == 0
    assert sorted(p.name for p in (folder / "reports").iterdir()) == ["top-wallets.pdf", "top-wallets.xlsx"]
    assert openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx").sheetnames[0] == "Answer"


FORMULA = '=HYPERLINK("http://x","y")'


def test_cells_that_look_like_formulas_stay_text_on_every_sheet(answered):
    root, folder = answered
    (folder / "results" / "top_wallets.csv").write_text(
        f'wallet,balance,share\n"{FORMULA.replace(chr(34), chr(34) * 2)}",+1+1,@SUM(A1)\n-x,\tcmd,"\rcmd"\n'
    )
    answer = json.loads((folder / "answer.json").read_text())
    answer["definitions"] = {"=term": "=1+1"}
    answer["checks"][0]["detail"] = "-2+3"
    (folder / "answer.json").write_text(json.dumps(answer))
    (folder / "answer.md").write_text("=cmd|' /C calc'!A0\n")

    assert run(root, "top-wallets", "xlsx") == 0
    book = openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx")
    top = book["top_wallets"]
    assert [(c.value, c.data_type) for c in top[2]] == [(FORMULA, "s"), ("+1+1", "s"), ("@SUM(A1)", "s")]
    assert [(c.value, c.data_type) for c in top[3][:2]] == [("-x", "s"), ("\tcmd", "s")]
    # XML parsing turns the CR into LF; what matters is that the cell is text.
    assert (top["C3"].value[1:], top["C3"].data_type) == ("cmd", "s")
    summary = [cell for row in book["Answer"].iter_rows() for cell in row if cell.value is not None]
    assert not [cell.value for cell in summary if cell.data_type == "f"]
    assert {"=term", "=1+1", "-2+3", "=cmd|' /C calc'!A0"} <= {cell.value for cell in summary}


def test_pdf_never_loads_images_or_raw_html_from_answer_md(answered, monkeypatch):
    root, folder = answered
    (folder / "answer.md").write_text(
        '# Answer\n\n<div><img src="/etc/shadow"></div>\n\n<img src="/etc/passwd">\n\nInline <img src="/etc/hosts"> too.\n\n'
        "![x](http://example.com/a.png)\n\n![y][ref]\n\n[ref]: http://example.com/b.png\n\n"
        "- **bold** item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    )

    def refuse(*args, **kwargs):
        raise AssertionError(f"fpdf2 tried to load an image: {args}")

    monkeypatch.setattr("fpdf.FPDF.image", refuse)
    monkeypatch.setattr("fpdf.image_parsing.load_image", refuse)
    assert run(root, "top-wallets", "pdf") == 0
    assert (folder / "reports" / "top-wallets.pdf").read_bytes().startswith(b"%PDF")


def pdf_lines(path):
    """The text of each text-showing operation in the PDF at path, in the order of its compressed content streams."""
    lines = []
    for stream in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", path.read_bytes(), re.S):
        lines += re.findall(rb"\((.*?)\) ?Tj", zlib.decompress(stream))
    return [line.decode("latin-1") for line in lines]


def test_fenced_code_keeps_its_lines_in_pdf_and_docx_as_literal_text(answered, monkeypatch):
    root, folder = answered
    code = ["select 1", "  from t", '<img src="/etc/passwd">']
    (folder / "answer.md").write_text("Run this:\n\n```sql\n" + "\n".join(code) + "\n```\n")

    def refuse(*args, **kwargs):
        raise AssertionError(f"fpdf2 tried to load an image: {args}")

    monkeypatch.setattr("fpdf.FPDF.image", refuse)
    monkeypatch.setattr("fpdf.image_parsing.load_image", refuse)
    assert run(root, "top-wallets", "pdf,docx") == 0
    assert "\n".join(code) in "\n".join(pdf_lines(folder / "reports" / "top-wallets.pdf"))
    path = folder / "reports" / "top-wallets.docx"
    assert outline(path)[3:5] == [("Normal", "Run this:"), ("Normal", "\n".join(code))]
    assert {run.font.name for run in docx.Document(path).paragraphs[4].runs} == {"Courier New"}


def outline(path):
    """The body of a DOCX in order: (style, text) for a paragraph, ("table", rows of cell texts) for a table."""
    document = docx.Document(path)
    return [
        ("table", [[cell.text for cell in row.cells] for row in block.rows])
        if isinstance(block, Table)
        else (block.style.name, block.text)
        for block in document.iter_inner_content()
    ]


def test_docx_has_the_pdf_content_in_the_pdf_order(answered):
    root, folder = answered
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    checks = [["Check", "Status", "Detail"], *([c["name"], c["status"], c["detail"]] for c in ANSWER["checks"])]
    assert outline(path) == [
        ("Title", ANSWER["question"]),
        ("Normal", "Value: none"),
        ("Normal", "Answered at 2026-11-04T19:00:00Z"),
        ("Heading 1", "Top wallets"),
        ("Normal", "The largest wallet holds 1.23 million ETH — “the deposit contract”."),
        ("List Bullet", "It leads by a wide margin…"),
        ("List Bullet", "Values are in wei ≈ 10⁻¹⁸ ETH."),
        ("table", [["wallet", "note"], ["deposit", "✓ checked"]]),
        ("Heading 2", "Definitions"),
        ("Normal", "wallet: An address in addresses.json → one row per asset."),
        ("Heading 2", "Checks"),
        ("table", checks),
        ("Heading 2", "top_wallets"),
        ("table", [["wallet", "balance", "share"], [ADDRESS, BALANCE, "0.25"], ["x", "", "007"]]),
        ("Normal", "results/top_wallets.csv has 2 rows."),
        ("Heading 2", LONG_NAME),
        ("table", [["n"], *([str(i)] for i in range(50))]),
        ("Normal", f"results/{LONG_NAME}.csv has 60 rows, the first 50 shown above."),
        ("Heading 2", "Provenance"),
        ("Normal", "git_sha: abc123"),
        ("Normal", "git_dirty: False"),
        ("Normal", "dbt_version: 1.12.6"),
    ]
    document = docx.Document(path)
    bold = {run.text for paragraph in document.paragraphs for run in paragraph.runs if run.bold}
    assert {"1.23 million ETH", "wallet"} <= bold
    assert all(cell.paragraphs[0].runs[0].bold for table in document.tables for cell in table.rows[0].cells)
    assert not (folder / "reports" / "top-wallets.pdf").exists()


def test_docx_renders_marks_lists_and_links_from_answer_md(answered):
    root, folder = answered
    (folder / "answer.md").write_text(
        "Plain *italic* and `code` and **bold**, see [the explorer](https://etherscan.io/address/x).\n\n"
        "    select 1\n      from t\n\n"
        "1. first\n2. second\n    - nested\n\n> quoted\n\n"
        "Between the lists.\n\n1. again\n"
    )
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    assert outline(path)[3:11] == [
        ("Normal", "Plain italic and code and bold, see the explorer (https://etherscan.io/address/x)."),
        ("Normal", "select 1\n  from t"),
        ("List Continue", "1. first"),
        ("List Continue", "2. second"),
        ("List Bullet 2", "nested"),
        ("Quote", "quoted"),
        ("Normal", "Between the lists."),
        ("List Continue", "1. again"),
    ]
    paragraphs = docx.Document(path).paragraphs
    assert [run.font.name for run in paragraphs[4].runs] == ["Courier New"]
    marks = [(run.text, run.italic, run.font.name, run.bold) for run in paragraphs[3].runs]
    assert ("italic", True, None, None) in marks
    assert ("code", None, "Courier New", None) in marks
    assert ("bold", None, None, True) in marks


def test_docx_writes_answer_md_and_chain_data_as_literal_text(answered, monkeypatch):
    root, folder = answered
    (folder / "answer.md").write_text(
        '<div><img src="/etc/shadow"></div>\n\n<img src="/etc/passwd">\n\nInline <img src="/etc/hosts"> too.\n\n'
        "![x](http://example.com/a.png)\n\n![y][ref]\n\n[ref]: http://example.com/b.png\n\n"
        "=cmd|' /C calc'!A0\n"
    )
    (folder / "results" / "top_wallets.csv").write_text(
        f'wallet,balance,share\n"{FORMULA.replace(chr(34), chr(34) * 2)}",+1+1,bell\x07\n'
    )
    answer = json.loads((folder / "answer.json").read_text())
    answer["definitions"] = {"=term": "=1+1"}
    (folder / "answer.json").write_text(json.dumps(answer))

    def refuse(*args, **kwargs):
        raise AssertionError(f"python-docx tried to add an image: {args}")

    monkeypatch.setattr("docx.document.Document.add_picture", refuse)
    monkeypatch.setattr("docx.text.run.Run.add_picture", refuse)
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    body = outline(path)
    assert body[3:9] == [
        ("Normal", '<div><img src="/etc/shadow"></div>'),
        ("Normal", '<img src="/etc/passwd">'),
        ("Normal", 'Inline <img src="/etc/hosts"> too.'),
        ("Normal", "![x](http://example.com/a.png)"),
        ("Normal", "![y]ref (http://example.com/b.png)"),
        ("Normal", "=cmd|' /C calc'!A0"),
    ]
    assert ("Normal", "=term: =1+1") in body
    assert ("table", [["wallet", "balance", "share"], [FORMULA, "+1+1", "bell\ufffd"]]) in body
    with zipfile.ZipFile(path) as package:
        assert not [name for name in package.namelist() if name.startswith("word/media/")]
        xml = package.read("word/document.xml").decode()
    assert not [tag for tag in ("w:fldSimple", "w:instrText", "w:hyperlink", "w:drawing", "w:pict") if tag in xml]


def test_docx_properties_name_blockjuice_and_the_answer_time(answered):
    root, folder = answered
    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    properties = docx.Document(path).core_properties
    answered_at = datetime(2026, 11, 4, 19, tzinfo=timezone.utc)
    assert (properties.title, properties.author, properties.comments) == (ANSWER["question"], "blockjuice", "")
    assert (properties.created, properties.modified) == (answered_at, answered_at)
    with zipfile.ZipFile(path) as package:
        assert "python-docx" not in package.read("docProps/core.xml").decode()


def test_characters_xml_cannot_hold_become_replacement_characters_in_docx_and_xlsx(answered):
    root, folder = answered
    (folder / "answer.md").write_text("token \ufffe name\n")
    (folder / "results" / "top_wallets.csv").write_text("wallet,balance,share\nbad\uffff,1,2\n")
    answer = json.loads((folder / "answer.json").read_text())
    answer["definitions"] = {"lone": "a\ud800b"}
    # json.dumps writes the lone surrogate as the escape \ud800, which json.loads reads back as a lone surrogate.
    (folder / "answer.json").write_text(json.dumps(answer))

    assert run(root, "top-wallets", "xlsx,pdf,docx") == 0
    body = outline(folder / "reports" / "top-wallets.docx")
    assert ("Normal", "token \ufffd name") in body
    assert ("Normal", "lone: a\ufffdb") in body
    assert ("table", [["wallet", "balance", "share"], ["bad\ufffd", "1", "2"]]) in body
    book = openpyxl.load_workbook(folder / "reports" / "top-wallets.xlsx")
    assert {"token \ufffd name", "a\ufffdb"} <= {cell.value for row in book["Answer"].iter_rows() for cell in row}
    assert book["top_wallets"]["A2"].value == "bad\ufffd"


def test_docx_title_property_stops_at_255_characters_and_the_body_keeps_the_question(answered):
    root, folder = answered
    question = "How much ETH do the tracked wallets hold right now, " * 6 + "in wei?"
    answer = json.loads((folder / "answer.json").read_text())
    answer["question"] = question
    (folder / "answer.json").write_text(json.dumps(answer))

    assert run(root, "top-wallets", "docx") == 0
    path = folder / "reports" / "top-wallets.docx"
    assert docx.Document(path).core_properties.title == question[:255]
    assert outline(path)[0] == ("Title", question)


def test_missing_answer_md_is_bad_input_and_writes_nothing(answered):
    root, folder = answered
    (folder / "answer.md").unlink()
    with pytest.raises(BadInput, match="answer.md does not exist: write the answer there first"):
        run(root, "top-wallets")
    assert not (folder / "reports").exists()


def test_unknown_format_exits_2(answered, monkeypatch, capsys):
    root, _ = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    assert main(["report", "top-wallets", "--format", "html"]) == 2
    assert "--format takes" in capsys.readouterr().err


@pytest.mark.parametrize(
    "text, value",
    [
        ("12", 12),
        ("-3.5", -3.5),
        ("123456789012345", 123456789012345),
        ("1234567890123456", "1234567890123456"),
        (BALANCE, BALANCE),
        ("0.1", 0.1),
        ("0.12345678901234567", "0.12345678901234567"),
        ("1e400", "1e400"),
        ("007", "007"),
        ("2026-11-04", "2026-11-04"),
        ("", None),
    ],
)
def test_cells_become_numbers_only_when_a_float_holds_them_exactly(text, value):
    assert cell_value(text) == value
    assert type(cell_value(text)) is type(value)


def drive_error(status, message="refused"):
    return HttpError(httplib2.Response({"status": str(status)}), json.dumps({"error": {"message": message}}).encode())


class FakeDrive:
    """The files() part of a Drive v3 client, keeping each Doc in memory with the DOCX uploaded to it. It records
    each request as (method, options), and the execute of a request whose method is in fail raises that error."""

    def __init__(self):
        self.docs = {}
        self.fail = {}
        self.calls = []

    def files(self):
        return self

    def request(self, method, options, result):
        self.calls.append((method, options))

        def execute():
            if method in self.fail:
                raise self.fail[method]
            return result()

        return SimpleNamespace(execute=execute)

    def link(self, doc_id):
        return {"id": doc_id, "webViewLink": f"https://docs.google.com/document/d/{doc_id}/edit"}

    def get(self, fileId, fields, **options):
        def trashed():
            if fileId not in self.docs:
                raise drive_error(404)
            return {"trashed": self.docs[fileId]["trashed"]}

        return self.request("get", options, trashed)

    def create(self, body, media_body, **options):
        def add():
            doc_id = f"doc-{len(self.docs) + 1}"
            self.docs[doc_id] = {**body, "trashed": False, "upload": media_body}
            return self.link(doc_id)

        return self.request("create", options, add)

    def update(self, fileId, media_body, **options):
        def upload():
            self.docs[fileId]["upload"] = media_body
            return self.link(fileId)

        return self.request("update", options, upload)


def uploaded_text(doc):
    upload = doc["upload"]
    assert upload.mimetype() == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return [paragraph.text for paragraph in docx.Document(io.BytesIO(upload.getbytes(0, upload.size()))).paragraphs]


@pytest.fixture
def drive(monkeypatch):
    fake = FakeDrive()
    monkeypatch.setattr("pipeline.cli.gdoc.connect", lambda: fake)
    monkeypatch.delenv("GOOGLE_DRIVE_FOLDER_ID", raising=False)
    return fake


def test_gdoc_creates_a_doc_then_updates_the_same_doc(answered, drive, monkeypatch, capsys):
    root, folder = answered
    monkeypatch.setenv("GOOGLE_DRIVE_FOLDER_ID", "folder-1")
    record = folder / "reports" / "top-wallets.gdoc.json"
    url = "https://docs.google.com/document/d/doc-1/edit"

    assert run(root, "top-wallets", "gdoc") == 0
    assert list(drive.docs) == ["doc-1"]
    doc = drive.docs["doc-1"]
    assert (doc["name"], doc["mimeType"], doc["parents"]) == (ANSWER["question"], "application/vnd.google-apps.document", ["folder-1"])
    assert uploaded_text(doc)[:3] == [ANSWER["question"], "Value: none", "Answered at 2026-11-04T19:00:00Z"]
    assert json.loads(record.read_text()) == {"id": "doc-1", "url": url}
    assert capsys.readouterr().out == f"created {url}\n"
    assert sorted(p.name for p in record.parent.iterdir()) == ["top-wallets.gdoc.json"]

    (folder / "answer.md").write_text("A second answer.\n")
    assert run(root, "top-wallets", "gdoc") == 0
    assert list(drive.docs) == ["doc-1"]
    assert "A second answer." in uploaded_text(drive.docs["doc-1"])
    assert json.loads(record.read_text()) == {"id": "doc-1", "url": url}
    assert capsys.readouterr().out == f"updated {url}\n"
    assert [(method, options.get("supportsAllDrives")) for method, options in drive.calls] == [
        ("create", True),
        ("get", True),
        ("update", True),
    ]


@pytest.mark.parametrize(
    "error", [pytest.param(drive_error(500), id="500"), pytest.param(drive_error(403, "Rate Limit Exceeded"), id="rate-limit")]
)
def test_gdoc_exits_2_without_a_new_doc_when_drive_cannot_say_whether_it_has_the_doc(answered, drive, monkeypatch, capsys, error):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    (folder / "reports").mkdir()
    record = folder / "reports" / "top-wallets.gdoc.json"
    record.write_text(json.dumps({"id": "doc-1", "url": "https://docs.google.com/document/d/doc-1/edit"}))
    drive.docs["doc-1"] = {"trashed": False}
    drive.fail = {"get": error}

    assert main(["report", "top-wallets", "--format", "gdoc"]) == 2
    assert f"Google Drive refused the upload: {error.status_code} {error.reason}" in capsys.readouterr().err
    assert [method for method, _ in drive.calls] == ["get"]
    assert list(drive.docs) == ["doc-1"]
    assert json.loads(record.read_text())["id"] == "doc-1"


@pytest.mark.parametrize("gone", ["deleted", "trashed"])
def test_gdoc_creates_a_new_doc_when_the_recorded_one_is_gone(answered, drive, capsys, gone):
    root, folder = answered
    (folder / "reports").mkdir()
    record = folder / "reports" / "top-wallets.gdoc.json"
    record.write_text(json.dumps({"id": "old", "url": "https://docs.google.com/document/d/old/edit"}))
    if gone == "trashed":
        drive.docs["old"] = {"trashed": True}

    assert run(root, "top-wallets", "gdoc") == 0
    created = [doc_id for doc_id in drive.docs if doc_id != "old"]
    assert len(created) == 1
    new = created[0]
    assert uploaded_text(drive.docs[new])[0] == ANSWER["question"]
    assert "upload" not in drive.docs.get("old", {})
    assert json.loads(record.read_text())["id"] == new
    assert capsys.readouterr().out.startswith("created ")


@pytest.mark.parametrize(
    "env, message",
    [
        ({}, "In a Google Cloud project, enable the Google Drive API, create an OAuth client ID of type Desktop app"),
        ({"GOOGLE_OAUTH_CLIENT_SECRET": "/missing/client.json"}, "GOOGLE_OAUTH_CLIENT_SECRET is /missing/client.json, which does not exist"),
        ({"GOOGLE_APPLICATION_CREDENTIALS": "/missing/key.json"}, "GOOGLE_APPLICATION_CREDENTIALS is /missing/key.json, which does not exist"),
        (
            {"GOOGLE_OAUTH_CLIENT_SECRET": "/missing/client.json", "GOOGLE_APPLICATION_CREDENTIALS": "/missing/key.json"},
            "GOOGLE_OAUTH_CLIENT_SECRET is /missing/client.json",
        ),
    ],
)
def test_gdoc_without_usable_credentials_exits_2_and_writes_nothing(answered, monkeypatch, capsys, env, message):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    for name in ("GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert main(["report", "top-wallets", "--format", "docx,gdoc"]) == 2
    assert message in capsys.readouterr().err
    assert not (folder / "reports").exists()


def test_gdoc_takes_only_a_service_account_key_from_google_application_credentials(tmp_path, monkeypatch):
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    key = tmp_path / "key.json"
    key.write_text(
        json.dumps(
            {
                "type": "service_account",
                "project_id": "project-1",
                "private_key_id": "key-1",
                "private_key": pem.decode(),
                "client_email": "bj@project-1.iam.gserviceaccount.com",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        )
    )
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(key))
    built = []
    monkeypatch.setattr(gdoc, "build", lambda *args, credentials, **kwargs: built.append(credentials))
    gdoc.connect()
    assert [(c.service_account_email, c.scopes) for c in built] == [("bj@project-1.iam.gserviceaccount.com", gdoc.SCOPES)]

    # What `gcloud auth application-default login` writes: a user's credentials, not a service account key.
    key.write_text(
        json.dumps({"type": "authorized_user", "client_id": "client-1", "client_secret": "secret", "refresh_token": "refresh-1"})
    )
    with pytest.raises(BadInput, match="GOOGLE_APPLICATION_CREDENTIALS is not a service account key"):
        gdoc.connect()


def google_token(token, expires_in):
    """User credentials holding token, which expires expires_in from now."""
    return Credentials(
        token=token,
        refresh_token="refresh-1",
        client_id="client-1",
        client_secret="secret",
        token_uri="https://oauth2.googleapis.com/token",
        scopes=gdoc.SCOPES,
        expiry=datetime.now(timezone.utc).replace(tzinfo=None) + expires_in,
    )


@pytest.fixture
def consents(tmp_path, monkeypatch):
    """A Desktop app client in GOOGLE_OAUTH_CLIENT_SECRET and a token cache under tmp_path. The consent step
    grants token-1 for an hour, and the list it returns gets the client id of each consent."""
    client = tmp_path / "client.json"
    client.write_text(
        json.dumps(
            {
                "installed": {
                    "client_id": "client-1",
                    "client_secret": "secret",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": ["http://localhost"],
                }
            }
        )
    )
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", str(client))
    monkeypatch.setattr(gdoc, "TOKEN", tmp_path / "blockjuice" / "google-token.json")
    granted = []

    def consent(flow, port):
        granted.append(flow.client_config["client_id"])
        return google_token("token-1", timedelta(hours=1))

    monkeypatch.setattr(InstalledAppFlow, "run_local_server", consent)
    return granted


def cache_token(token, expires_in):
    gdoc.TOKEN.parent.mkdir(parents=True, exist_ok=True)
    gdoc.TOKEN.write_text(google_token(token, expires_in).to_json())


def test_gdoc_asks_for_consent_once_and_caches_the_token(consents):
    gdoc.connect()
    gdoc.connect()
    assert consents == ["client-1"]
    assert json.loads(gdoc.TOKEN.read_text())["token"] == "token-1"
    assert gdoc.TOKEN.stat().st_mode & 0o777 == 0o600


def test_gdoc_rewrites_a_token_that_others_can_read_with_mode_600(consents):
    cache_token("token-0", timedelta(hours=1))
    gdoc.TOKEN.chmod(0o644)
    gdoc.connect()
    assert gdoc.TOKEN.stat().st_mode & 0o777 == 0o600
    assert json.loads(gdoc.TOKEN.read_text())["token"] == "token-0"


def test_gdoc_keeps_the_cached_token_whole_when_writing_the_new_one_fails(consents, monkeypatch):
    cache_token("token-0", timedelta(hours=1))
    cached = gdoc.TOKEN.read_text()
    # UTF-8 cannot encode a lone surrogate, so the write fails after the file is open, as on a full disk.
    monkeypatch.setattr(Credentials, "to_json", lambda credentials: '{"token": "\ud800"}')
    with pytest.raises(UnicodeEncodeError):
        gdoc.connect()
    assert gdoc.TOKEN.read_text() == cached
    assert [path.name for path in gdoc.TOKEN.parent.iterdir()] == [gdoc.TOKEN.name]


def test_gdoc_refreshes_an_expired_token_without_asking_again(consents, monkeypatch):
    cache_token("token-0", timedelta(hours=-1))

    def refresh(credentials, request):
        credentials.token = "token-2"
        credentials.expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1)

    monkeypatch.setattr(Credentials, "refresh", refresh)
    gdoc.connect()
    assert consents == []
    assert json.loads(gdoc.TOKEN.read_text())["token"] == "token-2"


def test_gdoc_asks_for_consent_again_when_google_refuses_the_refresh(consents, monkeypatch):
    cache_token("token-0", timedelta(hours=-1))

    def refuse(credentials, request):
        raise RefreshError("invalid_grant: Token has been expired or revoked.")

    monkeypatch.setattr(Credentials, "refresh", refuse)
    gdoc.connect()
    assert consents == ["client-1"]
    assert json.loads(gdoc.TOKEN.read_text())["token"] == "token-1"


def test_gdoc_exits_2_when_google_cannot_be_reached_for_the_refresh(consents, monkeypatch):
    cache_token("token-0", timedelta(hours=-1))

    def unreachable(credentials, request):
        raise TransportError("Unable to find the server at oauth2.googleapis.com")

    monkeypatch.setattr(Credentials, "refresh", unreachable)
    with pytest.raises(BadInput, match="Could not reach Google: Unable to find the server at oauth2.googleapis.com"):
        gdoc.connect()
    assert consents == []


@pytest.mark.parametrize("cached", ["", "not json\n", "{}"])
def test_gdoc_exits_2_when_the_cached_token_is_not_a_token(consents, cached):
    gdoc.TOKEN.parent.mkdir(parents=True)
    gdoc.TOKEN.write_text(cached)
    with pytest.raises(BadInput, match=f"{re.escape(str(gdoc.TOKEN))} is not a Google token .*: delete it to sign in again"):
        gdoc.connect()
    assert consents == []
    assert gdoc.TOKEN.read_text() == cached


@pytest.mark.parametrize("recorded", ["<<<<<<< HEAD\n", '{"url": "https://docs.google.com/document/d/doc-1/edit"}', "[]"])
def test_gdoc_exits_2_when_the_record_holds_no_doc_id(answered, drive, monkeypatch, capsys, recorded):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    (folder / "reports").mkdir()
    record = folder / "reports" / "top-wallets.gdoc.json"
    record.write_text(recorded)

    assert main(["report", "top-wallets", "--format", "gdoc"]) == 2
    err = capsys.readouterr().err
    assert err.count("\n") == 1
    assert f"{record} does not hold a Doc id: fix it, or delete it to create a new Doc" in err
    assert drive.calls == []
    assert record.read_text() == recorded


@pytest.mark.parametrize(
    "error, message",
    [
        pytest.param(
            RefreshError("invalid_grant: Token has been expired or revoked.", {"error": "invalid_grant"}),
            "Google refused the credentials (invalid_grant: Token has been expired or revoked.)",
            id="revoked",
        ),
        pytest.param(
            RefreshError("<html>\n<body>Bad gateway</body>\n</html>"),
            "Google refused the credentials (<html> <body>Bad gateway</body> </html>)",
            id="refused-with-a-page",
        ),
        pytest.param(
            TransportError("Unable to find the server at oauth2.googleapis.com"),
            "Could not reach Google: Unable to find the server at oauth2",
            id="no-token-endpoint",
        ),
        pytest.param(
            ServerNotFoundError("Unable to find the server at www.googleapis.com"),
            "Could not reach Google: Unable to find the server at www",
            id="no-drive",
        ),
        pytest.param(
            ConnectionResetError(54, "Connection reset by peer"),
            "Could not reach Google: [Errno 54] Connection reset by peer",
            id="reset",
        ),
    ],
)
def test_gdoc_exits_2_with_one_line_when_a_request_fails_on_the_credentials_or_the_network(
    answered, drive, monkeypatch, capsys, error, message
):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    drive.fail = {"create": error}
    assert main(["report", "top-wallets", "--format", "gdoc"]) == 2
    err = capsys.readouterr().err
    assert err.count("\n") == 1
    assert message in err
    assert not (folder / "reports" / "top-wallets.gdoc.json").exists()


def test_gdoc_exits_2_when_drive_refuses_the_upload(answered, drive, monkeypatch, capsys):
    root, folder = answered
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", root)
    drive.fail = {"create": drive_error(403)}
    assert main(["report", "top-wallets", "--format", "gdoc"]) == 2
    assert "Google Drive refused the upload: 403 refused" in capsys.readouterr().err
    assert not (folder / "reports" / "top-wallets.gdoc.json").exists()


def test_the_other_formats_never_load_the_google_client(answered):
    root, _ = answered
    script = (
        "import sys; from pathlib import Path; from pipeline.cli.report import run; "
        f"run(Path({str(root)!r}), 'top-wallets', 'xlsx,pdf,docx'); "
        "print(sorted(m for m in sys.modules if m.startswith(('google', 'googleapiclient'))))"
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True)
    assert result.stdout.splitlines()[-1] == "[]"
