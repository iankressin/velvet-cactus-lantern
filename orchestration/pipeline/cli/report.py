"""bj report: an answer as an XLSX workbook, a PDF, a DOCX or a Google Doc, for readers who do not read JSON."""

import csv
import html
import json
import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal
from html.parser import HTMLParser
from pathlib import Path
from typing import IO, Any

import docx
import markdown
from docx.document import Document
from docx.text.paragraph import Paragraph
from fpdf import FPDF
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.worksheet import Worksheet

from pipeline.cli import BadInput
from pipeline.cli.question import answer_dir

FORMATS = ("xlsx", "pdf", "docx", "gdoc")
ROWS_SHOWN = 50
# A plain decimal number. Leading zeros make it an identifier, which stays text.
NUMBER = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$")
# The PDF core fonts hold Latin-1 only. These code points read the same in ASCII; anything else becomes "?".
ASCII = str.maketrans(
    {
        **dict.fromkeys((0x2018, 0x2019, 0x201A, 0x2032), "'"),  # single quotes, prime
        **dict.fromkeys((0x201C, 0x201D, 0x201E, 0x2033), '"'),  # double quotes, double prime
        **dict.fromkeys((0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212), "-"),  # hyphens, dashes, minus
        **dict.fromkeys((0x2007, 0x2009, 0x200A, 0x202F), " "),  # figure, thin and narrow spaces
        0x200B: "",  # zero-width space
        0x2026: "...",
        0x2022: "*",
        0x2190: "<-",
        0x2192: "->",
        0x2248: "~",
        0x2260: "!=",
        0x2264: "<=",
        0x2265: ">=",
    }
)
REPLACEMENT = chr(0xFFFD)
# The characters XML 1.0 cannot hold, which the DOCX and XLSX writers replace with REPLACEMENT: control characters
# other than tab, LF and CR, lone surrogates (json.loads makes them from escapes), U+FFFE and U+FFFF.
# openpyxl's ILLEGAL_CHARACTERS_RE matches only the control characters.
ILLEGAL_CHARACTERS_RE = re.compile(r"[^\t\n\r\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")


@dataclass(frozen=True)
class Table:
    name: str
    path: str
    columns: list[str]
    rows: list[list[str]]


@dataclass(frozen=True)
class Report:
    answer: dict[str, Any]
    text: str
    tables: list[Table]


def parse_formats(text: str) -> list[str]:
    formats = [part.strip() for part in text.split(",") if part.strip()]
    unknown = [f for f in formats if f not in FORMATS]
    if unknown or not formats:
        raise BadInput(f"--format takes a comma-separated list of {', '.join(FORMATS)}, not {text!r}")
    return formats


def load(folder: Path, slug: str) -> Report:
    answer_json, answer_md = folder / "answer.json", folder / "answer.md"
    if not answer_json.is_file():
        raise BadInput(f"answers/{slug}/answer.json does not exist: run `bj answer {slug}` first")
    if not answer_md.is_file():
        raise BadInput(f"answers/{slug}/answer.md does not exist: write the answer there first")
    try:
        answer = json.loads(answer_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BadInput(f"answers/{slug}/answer.json is not valid JSON ({error}): run `bj answer {slug}` again") from None
    tables = []
    for result in answer["results"]:
        path = folder / result["path"]
        if not path.is_file():
            raise BadInput(f"answers/{slug}/{result['path']} does not exist: run `bj answer {slug}` again")
        with open(path, newline="", encoding="utf-8") as file:
            columns, *rows = csv.reader(file)
        tables.append(Table(result["analysis"], result["path"], columns, rows))
    return Report(answer, answer_md.read_text(encoding="utf-8"), tables)


def cell_value(text: str) -> str | int | float | None:
    """A CSV cell as a number when a float holds it exactly in at most 15 significant digits, else as text,
    so a balance in wei keeps every digit."""
    if text == "":
        return None
    if not NUMBER.match(text):
        return text
    number = float(text)
    if Decimal(format(number, ".15g")) != Decimal(text):
        return text
    return int(text) if text.lstrip("-").isdigit() else number


def value_cell(answer: dict[str, Any]) -> Any:
    value = answer["value"]
    return cell_value(value) if isinstance(value, str) else value


def paragraphs(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"\n\s*\n", text.strip()) if part.strip()]


def row_count(table: Table) -> str:
    count = len(table.rows)
    shown = f", the first {ROWS_SHOWN} shown above" if count > ROWS_SHOWN else ""
    return f"{table.path} has {count} row{'s' if count != 1 else ''}{shown}."


def input_rows(answer: dict[str, Any]) -> list[list[Any]]:
    rows = []
    for item in answer["inputs"]:
        run = item["last_run"] or {}
        rows.append(
            [
                item["source"],
                item["raw_table"],
                run.get("finished_at", "never"),
                run.get("records_written"),
                run.get("dagster_run_id"),
                item["dead_letters"]["pending"],
                item["dead_letters"]["parked"],
            ]
        )
    return rows


INPUT_COLUMNS = ["Source", "Raw table", "Last successful run", "Records", "Dagster run", "Pending", "Parked"]


BOLD = Font(bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")


def append_row(sheet: Worksheet, values: Iterable[Any], *, bold: bool = False, wrap: bool = False) -> None:
    """Appends values as cells, every string as text. openpyxl writes a string starting with = as a
    formula, and result cells and answer.md can hold chain data that anyone sets, such as token names."""
    sheet.append([ILLEGAL_CHARACTERS_RE.sub(REPLACEMENT, v) if isinstance(v, str) else v for v in values])
    for cell in sheet[sheet.max_row]:
        if isinstance(cell.value, str):
            cell.data_type = "s"
        if bold:
            cell.font = BOLD
        if wrap:
            cell.alignment = WRAP


def write_xlsx(report: Report, path: Path) -> None:
    answer = report.answer
    book = Workbook()
    sheet = book.active
    sheet.title = "Answer"

    def section(title: str, columns: list[str] | None, rows: Iterable[Iterable[Any]]) -> None:
        sheet.append([])
        append_row(sheet, [title], bold=True)
        if columns:
            append_row(sheet, columns, bold=True)
        for row in rows:
            append_row(sheet, row, wrap=True)

    for label, value in (
        ("Question", answer["question"]),
        ("Value", value_cell(answer)),
        ("Answered at", answer["answered_at"]),
    ):
        append_row(sheet, [label, value], wrap=True)
        sheet.cell(sheet.max_row, 1).font = BOLD
    section("Answer", None, ([paragraph] for paragraph in paragraphs(report.text)))
    section("Definitions", ["Term", "Definition"], answer["definitions"].items())
    section("Checks", ["Check", "Status", "Detail"], ([c["name"], c["status"], c["detail"]] for c in answer["checks"]))
    section("Inputs", INPUT_COLUMNS, input_rows(answer))
    section("Provenance", None, answer["provenance"].items())
    sheet.column_dimensions["A"].width = 60
    sheet.column_dimensions["B"].width = 60
    sheet.column_dimensions["C"].width = 60

    for table in report.tables:
        result = book.create_sheet(table.name[:31])
        append_row(result, table.columns, bold=True)
        for row in table.rows:
            append_row(result, [cell_value(text) for text in row])
        result.freeze_panes = "A2"
    book.save(path)


def latin1(text: str) -> str:
    return str(text).translate(ASCII).encode("latin-1", "replace").decode("latin-1")


def markdown_html(text: str) -> str:
    """answer.md as HTML, with no raw HTML and no images: fpdf2 opens the file or URL of any <img>. fenced_code
    escapes the code it puts in <pre>, as an indented code block does."""
    converter = markdown.Markdown(extensions=["tables", "fenced_code"])
    converter.preprocessors.deregister("html_block")
    for pattern in ("html", "image_link", "image_reference", "short_image_ref"):
        converter.inlinePatterns.deregister(pattern)
    return converter.convert(text)


def write_pdf(report: Report, path: Path) -> None:
    answer = report.answer
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()

    def heading(text: str, size: int = 13) -> None:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", size)
        pdf.multi_cell(0, size * 0.5, latin1(text), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", size=10)

    def line(text: str) -> None:
        pdf.multi_cell(0, 5, latin1(text), new_x="LMARGIN", new_y="NEXT")

    def table(columns: list[str], rows: Iterable[Iterable[Any]]) -> None:
        pdf.set_font("Helvetica", size=7)
        with pdf.table(text_align="LEFT", line_height=3.5) as grid:
            for cells in [columns, *rows]:
                row = grid.row()
                for cell in cells:
                    row.cell(latin1("" if cell is None else cell))
        pdf.set_font("Helvetica", size=10)

    heading(answer["question"], size=16)
    value = answer["value"]
    line(f"Value: {'none' if value is None else value}")
    line(f"Answered at {answer['answered_at']}")
    pdf.ln(2)
    pdf.write_html(latin1(markdown_html(report.text)))

    if answer["definitions"]:
        heading("Definitions")
        pdf.write_html(
            latin1("".join(f"<p><b>{html.escape(k)}</b>: {html.escape(v)}</p>" for k, v in answer["definitions"].items()))
        )
    heading("Checks")
    table(["Check", "Status", "Detail"], ([c["name"], c["status"], c["detail"]] for c in answer["checks"]))
    for result in report.tables:
        heading(result.name)
        table(result.columns, result.rows[:ROWS_SHOWN])
        line(row_count(result))
    heading("Provenance")
    for key, value in answer["provenance"].items():
        line(f"{key}: {value}")
    pdf.output(str(path))


MONOSPACE = "Courier New"
HEADINGS = {f"h{level}": f"Heading {level}" for level in range(1, 7)}
BLOCKS = {*HEADINGS, "p", "ul", "ol", "li", "pre", "blockquote", "hr", "table"}
MARKS = {"strong": "bold", "em": "italic", "code": "code"}


@dataclass(frozen=True)
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    code: bool = False


def add_runs(paragraph: Paragraph, runs: Iterable[Run]) -> None:
    """Writes each run as literal text in a w:t element, which Word and Google Docs never read as a field or formula."""
    for run in runs:
        written = paragraph.add_run(ILLEGAL_CHARACTERS_RE.sub(REPLACEMENT, run.text))
        written.bold = run.bold or None
        written.italic = run.italic or None
        if run.code:
            written.font.name = MONOSPACE


def add_table(document: Document, rows: list[list[list[Run]]]) -> None:
    """Adds rows as a table whose first row is the header, in bold. A row is a list of cells, a cell a list of runs."""
    header, *body = rows
    grid = document.add_table(rows=len(rows), cols=max(len(row) for row in rows))
    grid.style = "Table Grid"
    for cells, row in zip(grid.rows, [[[replace(run, bold=True) for run in cell] for cell in header], *body]):
        for cell, runs in zip(cells.cells, row):
            add_runs(cell.paragraphs[0], runs)


def text_table(columns: list[str], rows: Iterable[Iterable[Any]]) -> list[list[list[Run]]]:
    return [[[Run("" if cell is None else str(cell))] for cell in row] for row in [columns, *rows]]


class DocxMarkdown(HTMLParser):
    """Writes the HTML of markdown_html into a document as headings, paragraphs, lists, quotes, code blocks
    and tables, with bold, italic and inline code. A link becomes its text and its URL in brackets."""

    def __init__(self, document: Document) -> None:
        super().__init__()
        self.document = document
        self.runs: list[Run] = []
        self.style: str | None = None
        self.prefix = ""
        # One entry per open list: None for a bulleted list, the items so far for a numbered one.
        self.lists: list[int | None] = []
        self.quotes = 0
        self.pre = False
        self.marks: Counter[str] = Counter()
        self.links: list[tuple[str, int]] = []
        self.table: list[list[list[Run]]] = []

    def run(self, text: str) -> Run:
        return Run(text, **{mark: self.marks[mark] > 0 for mark in MARKS.values()})

    def list_style(self, name: str) -> str:
        depth = min(len(self.lists), 3)
        return name if depth == 1 else f"{name} {depth}"

    def flush(self) -> None:
        runs, self.runs = self.runs, []
        if not "".join(run.text for run in runs).strip():
            return
        if self.pre:
            runs[-1] = replace(runs[-1], text=runs[-1].text.rstrip("\n"))
        else:
            runs[0] = replace(runs[0], text=runs[0].text.lstrip())
            runs[-1] = replace(runs[-1], text=runs[-1].text.rstrip())
        if self.style is None and self.lists:
            self.style = self.list_style("List Continue")
        elif self.style is None and self.quotes:
            self.style = "Quote"
        add_runs(self.document.add_paragraph(style=self.style), [Run(self.prefix), *runs] if self.prefix else runs)
        self.style, self.prefix = None, ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in BLOCKS:
            self.flush()
        if tag in HEADINGS:
            self.style = HEADINGS[tag]
        elif tag == "ul":
            self.lists.append(None)
        elif tag == "ol":
            self.lists.append(0)
        elif tag == "li" and self.lists[-1] is None:
            self.style = self.list_style("List Bullet")
        elif tag == "li":
            # Word's List Number style counts on from the previous list, so each item carries its number as text.
            self.lists[-1] += 1
            self.style = self.list_style("List Continue")
            self.prefix = f"{self.lists[-1]}. "
        elif tag == "blockquote":
            self.quotes += 1
        elif tag == "pre":
            self.pre = True
        elif tag == "tr":
            self.table.append([])
        elif tag in ("th", "td"):
            self.runs = []
        elif tag in MARKS:
            self.marks[MARKS[tag]] += 1
        elif tag == "a":
            self.links.append((dict(attrs).get("href") or "", len(self.runs)))
        elif tag == "br":
            self.runs.append(self.run("\n"))

    def handle_endtag(self, tag: str) -> None:
        if tag in BLOCKS:
            self.flush()
            self.style, self.prefix = None, ""
        if tag in ("ul", "ol"):
            self.lists.pop()
        elif tag == "blockquote":
            self.quotes -= 1
        elif tag == "pre":
            self.pre = False
        elif tag in ("th", "td"):
            self.table[-1].append(self.runs)
            self.runs = []
        elif tag == "table":
            add_table(self.document, self.table)
            self.table = []
        elif tag in MARKS:
            self.marks[MARKS[tag]] -= 1
        elif tag == "a":
            href, start = self.links.pop()
            if href and href != "".join(run.text for run in self.runs[start:]).strip():
                self.runs.append(self.run(f" ({href})"))

    def handle_data(self, data: str) -> None:
        self.runs.append(self.run(data if self.pre else re.sub(r"\s+", " ", data)))


def write_docx(report: Report, target: Path | IO[bytes]) -> None:
    answer = report.answer
    document = docx.Document()
    properties = document.core_properties
    # python-docx refuses a property longer than 255 characters. The Title paragraph keeps the whole question.
    properties.title = ILLEGAL_CHARACTERS_RE.sub(REPLACEMENT, answer["question"])[:255]
    # In place of the author, description and 2013 dates of python-docx's template.
    properties.author = "blockjuice"
    properties.comments = ""
    properties.created = properties.modified = datetime.fromisoformat(answer["answered_at"])

    def paragraph(*runs: Run, style: str | None = None) -> None:
        add_runs(document.add_paragraph(style=style), runs)

    paragraph(Run(answer["question"]), style="Title")
    value = answer["value"]
    paragraph(Run(f"Value: {'none' if value is None else value}"))
    paragraph(Run(f"Answered at {answer['answered_at']}"))
    parser = DocxMarkdown(document)
    parser.feed(markdown_html(report.text))
    parser.close()

    if answer["definitions"]:
        paragraph(Run("Definitions"), style="Heading 2")
        for term, definition in answer["definitions"].items():
            paragraph(Run(term, bold=True), Run(f": {definition}"))
    paragraph(Run("Checks"), style="Heading 2")
    add_table(document, text_table(["Check", "Status", "Detail"], ([c["name"], c["status"], c["detail"]] for c in answer["checks"])))
    for result in report.tables:
        paragraph(Run(result.name), style="Heading 2")
        add_table(document, text_table(result.columns, result.rows[:ROWS_SHOWN]))
        paragraph(Run(row_count(result)))
    paragraph(Run("Provenance"), style="Heading 2")
    for key, value in answer["provenance"].items():
        paragraph(Run(f"{key}: {value}"))
    document.save(target)


WRITERS = {"xlsx": write_xlsx, "pdf": write_pdf, "docx": write_docx}


def run(repo_root: Path, slug: str, formats: str = "xlsx,pdf") -> int:
    chosen = parse_formats(formats)
    folder = answer_dir(repo_root, slug)
    report = load(folder, slug)
    reports = folder / "reports"
    if "gdoc" in chosen:
        # Imported here so that the other formats never load the Google client. It runs first, so that
        # missing Google credentials stop the command before it writes anything.
        from pipeline.cli import gdoc

        print(gdoc.publish(report, reports / f"{slug}.gdoc.json"))
    reports.mkdir(exist_ok=True)
    for name in chosen:
        if name in WRITERS:
            path = reports / f"{slug}.{name}"
            WRITERS[name](report, path)
            print(f"wrote {path.relative_to(repo_root)}")
    return 0
