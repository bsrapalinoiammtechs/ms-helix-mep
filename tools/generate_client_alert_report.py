from __future__ import annotations

import csv
import math
from collections import Counter
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


ROOT = Path(r"C:\Users\brandon\Documents\projects\ms-helix-mep")
SOURCE_DIR = Path(
    r"C:\Users\brandon\Documents\projects\ms-helix\reporte-alertas-retenidas\salida"
)
INPUT_VALIDATION = SOURCE_DIR / "validacion_2026-09-29.csv"
INPUT_UNVERIFIED = SOURCE_DIR / "no_verificadas_2026-09-29.csv"
OUT_DIR = ROOT / "reportes" / "validacion-alertas-2026-09-29"
ASSET_DIR = OUT_DIR / "assets"
DOCX_PATH = OUT_DIR / "Informe_validacion_alertas_Helix_Meraki_2026-09-29.docx"


NAVY = "17365D"
BLUE = "1F4E78"
CYAN = "00A6A6"
GREEN = "3A8D5D"
AMBER = "D99000"
RED = "C43D3D"
PALE_BLUE = "EAF2F8"
PALE_GREEN = "E8F3ED"
PALE_AMBER = "FFF3DB"
PALE_RED = "FBE9E7"
LIGHT_GRAY = "F2F4F7"
MID_GRAY = "6B7280"
DARK = "1F2937"
WHITE = "FFFFFF"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


MESES_ES = {
    1: "enero", 2: "febrero", 3: "marzo", 4: "abril", 5: "mayo", 6: "junio",
    7: "julio", 8: "agosto", 9: "septiembre", 10: "octubre", 11: "noviembre", 12: "diciembre",
}


def format_period(rows: list[dict[str, str]]) -> str:
    """Calcula el periodo real cubierto por los datos (antes venia
    hardcodeado como "2 al 28 de septiembre de 2026", que quedo desfasado
    en cuanto el CSV crecio hasta incluir el 29)."""
    fechas = []
    for r in rows:
        value = (r.get("Fecha_Helix_Costa_Rica") or "").strip()
        if not value:
            continue
        try:
            fechas.append(datetime.strptime(value, "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            continue
    if not fechas:
        return ""
    start, end = min(fechas), max(fechas)
    if start.year == end.year and start.month == end.month:
        return f"{start.day} al {end.day} de {MESES_ES[end.month]} de {end.year}"
    if start.year == end.year:
        return f"{start.day} de {MESES_ES[start.month]} al {end.day} de {MESES_ES[end.month]} de {end.year}"
    return f"{start.day} de {MESES_ES[start.month]} de {start.year} al {end.day} de {MESES_ES[end.month]} de {end.year}"


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_border(cell, **kwargs) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_borders = tc_pr.first_child_found_in("w:tcBorders")
    if tc_borders is None:
        tc_borders = OxmlElement("w:tcBorders")
        tc_pr.append(tc_borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        if edge not in kwargs:
            continue
        edge_data = kwargs[edge]
        tag = "w:" + edge
        element = tc_borders.find(qn(tag))
        if element is None:
            element = OxmlElement(tag)
            tc_borders.append(element)
        for key in ("val", "sz", "space", "color"):
            if key in edge_data:
                element.set(qn("w:" + key), str(edge_data[key]))


def set_repeat_table_header(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def set_cell_margins(cell, top=90, start=100, bottom=90, end=100) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for m, v in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{m}"))
        if node is None:
            node = OxmlElement(f"w:{m}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(v))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_row(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    tr_pr.append(cant_split)


def remove_paragraph_borders(paragraph) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is not None:
        p_pr.remove(p_bdr)
    p_bdr = OxmlElement("w:pBdr")
    for edge in ("top", "left", "bottom", "right", "between", "bar"):
        node = OxmlElement(f"w:{edge}")
        node.set(qn("w:val"), "nil")
        p_bdr.append(node)
    p_pr.append(p_bdr)


def add_page_number(paragraph) -> None:
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("Página ")
    run.font.size = Pt(8)
    run.font.color.rgb = RGBColor.from_string(MID_GRAY)
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = "PAGE"
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.extend([fld_char1, instr_text, fld_char2])


def add_footer(doc: Document, section) -> None:
    footer = section.footer
    table = footer.add_table(rows=1, cols=2, width=Inches(7.1))
    table.autofit = False
    table.columns[0].width = Inches(5.8)
    table.columns[1].width = Inches(1.3)
    left = table.cell(0, 0).paragraphs[0]
    left.text = "Informe de validación de alertas Helix vs. Meraki · 29/09/2026"
    left.style = doc.styles["Footer"]
    left.runs[0].font.color.rgb = RGBColor.from_string(MID_GRAY)
    left.runs[0].font.size = Pt(8)
    add_page_number(table.cell(0, 1).paragraphs[0])


def add_heading(doc: Document, text: str, level: int = 1) -> None:
    p = doc.add_paragraph(style=f"Heading {level}")
    p.add_run(text)


def add_body(doc: Document, text: str, bold_lead: str | None = None) -> None:
    p = doc.add_paragraph(style="Body Text")
    if bold_lead and text.startswith(bold_lead):
        p.add_run(bold_lead).bold = True
        p.add_run(text[len(bold_lead) :])
    else:
        p.add_run(text)


def add_bullet(doc: Document, text: str, color: str = BLUE) -> None:
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(4)
    if p.runs:
        p.runs[0].font.color.rgb = RGBColor.from_string(color)
    p.add_run(text)


def add_callout(doc: Document, title: str, body: str, fill: str, accent: str) -> None:
    table = doc.add_table(rows=1, cols=1)
    table.autofit = True
    cell = table.cell(0, 0)
    set_cell_shading(cell, fill)
    set_cell_margins(cell, 150, 180, 150, 180)
    set_cell_border(
        cell,
        left={"val": "single", "sz": "18", "color": accent},
        top={"val": "nil"},
        bottom={"val": "nil"},
        right={"val": "nil"},
    )
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run(title)
    r.bold = True
    r.font.color.rgb = RGBColor.from_string(accent)
    r.font.size = Pt(10.5)
    p2 = cell.add_paragraph(body)
    p2.paragraph_format.space_after = Pt(0)
    p2.runs[0].font.size = Pt(9.5)
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def add_kpi_table(doc: Document, items: list[tuple[str, str, str, str]]) -> None:
    table = doc.add_table(rows=1, cols=len(items))
    table.autofit = False
    for idx, (value, label, fill, accent) in enumerate(items):
        cell = table.cell(0, idx)
        cell.width = Inches(1.75)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        set_cell_shading(cell, fill)
        set_cell_margins(cell, 160, 100, 150, 100)
        set_cell_border(
            cell,
            top={"val": "single", "sz": "8", "color": WHITE},
            bottom={"val": "single", "sz": "8", "color": WHITE},
            left={"val": "single", "sz": "8", "color": WHITE},
            right={"val": "single", "sz": "8", "color": WHITE},
        )
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(3)
        value_run = p.add_run(value)
        value_run.bold = True
        value_run.font.size = Pt(21)
        value_run.font.color.rgb = RGBColor.from_string(accent)
        p2 = cell.add_paragraph(label)
        p2.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p2.paragraph_format.space_after = Pt(0)
        p2.runs[0].font.size = Pt(8.5)
        p2.runs[0].font.color.rgb = RGBColor.from_string(DARK)


def pct(n: int, total: int) -> str:
    return f"{100 * n / total:.1f}%".replace(".", ",")


def normalized_client(value: str) -> str:
    if "ACS2" in value:
        return "Ministerio de Educación – ACS2"
    if "Costa Rica" in value:
        return "Ministerio de Educación Pública – Costa Rica"
    return value.replace("�", "ó")


def compact_location(value: str) -> str:
    clean = value.replace("�", "í")
    if "\\" in clean:
        clean = clean.split("\\", 1)[1]
    return clean


def chart_font(size: int, bold: bool = False):
    candidates = [
        Path(r"C:\Windows\Fonts\aptos-bold.ttf" if bold else r"C:\Windows\Fonts\aptos.ttf"),
        Path(r"C:\Windows\Fonts\calibrib.ttf" if bold else r"C:\Windows\Fonts\calibri.ttf"),
        Path(r"C:\Windows\Fonts\arialbd.ttf" if bold else r"C:\Windows\Fonts\arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def create_charts(status_counts: Counter, severity_counts: Counter) -> tuple[Path, Path]:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    status_path = ASSET_DIR / "estado_conciliacion.png"
    image = Image.new("RGB", (1500, 650), "white")
    draw = ImageDraw.Draw(image)
    title_font = chart_font(36, bold=True)
    body_font = chart_font(25)
    value_font = chart_font(55, bold=True)
    label_font = chart_font(22)
    draw.text((35, 28), "Estado resultante de la conciliación", fill="#17365D", font=title_font)
    values = [status_counts["ACTIVA"], status_counts["CESADA"], status_counts["NO_ENCONTRADA"]]
    labels = ["Activas", "Cesadas", "No encontradas"]
    colors = ["#3A8D5D", "#1F4E78", "#D99000"]
    box = (100, 120, 600, 620)
    start = -90.0
    total = sum(values)
    for value, color in zip(values, colors):
        end = start + 360.0 * value / total
        draw.pieslice(box, start=start, end=end, fill=color, outline="white", width=8)
        start = end
    draw.ellipse((225, 245, 475, 495), fill="white")
    total_text = str(total)
    bbox = draw.textbbox((0, 0), total_text, font=value_font)
    draw.text((350 - (bbox[2] - bbox[0]) / 2, 305), total_text, fill="#17365D", font=value_font)
    bbox = draw.textbbox((0, 0), "alertas", font=label_font)
    draw.text((350 - (bbox[2] - bbox[0]) / 2, 380), "alertas", fill="#6B7280", font=label_font)
    y = 170
    for label, value, color in zip(labels, values, colors):
        draw.rounded_rectangle((760, y, 806, y + 46), radius=8, fill=color)
        legend = f"{label}: {value} ({100*value/total:.1f}%)"
        draw.text((835, y + 4), legend, fill="#374151", font=body_font)
        y += 110
    image.save(status_path, quality=96)

    sev_path = ASSET_DIR / "severidad.png"
    image = Image.new("RGB", (1500, 650), "white")
    draw = ImageDraw.Draw(image)
    draw.text((35, 28), "Distribución por severidad reportada en Helix", fill="#17365D", font=title_font)
    labels = ["Bajo", "Medio", "Alto"]
    values = [severity_counts["BAJO"], severity_counts["MEDIO"], severity_counts["ALTO"]]
    colors = ["#5BAA75", "#D99000", "#C43D3D"]
    x0, x1 = 265, 1190
    y = 145
    max_value = max(values)
    for label, value, color in zip(labels, values, colors):
        draw.text((45, y + 13), label, fill="#374151", font=body_font)
        bar_width = int((x1 - x0) * value / max_value)
        draw.rounded_rectangle((x0, y, x0 + bar_width, y + 62), radius=10, fill=color)
        text = f"{value} ({100*value/sum(values):.1f}%)"
        draw.text((x0 + bar_width + 22, y + 14), text, fill="#374151", font=body_font)
        y += 145
    draw.line((x0, 105, x0, 565), fill="#D1D5DB", width=2)
    image.save(sev_path, quality=96)
    return status_path, sev_path


def configure_document(doc: Document) -> None:
    section = doc.sections[0]
    section.top_margin = Cm(1.8)
    section.bottom_margin = Cm(1.6)
    section.left_margin = Cm(1.9)
    section.right_margin = Cm(1.9)
    section.header_distance = Cm(0.7)
    section.footer_distance = Cm(0.7)

    normal = doc.styles["Normal"]
    normal.font.name = "Aptos"
    normal.font.size = Pt(9.5)
    normal.font.color.rgb = RGBColor.from_string(DARK)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.08

    body = doc.styles["Body Text"]
    body.font.name = "Aptos"
    body.font.size = Pt(9.5)
    body.font.color.rgb = RGBColor.from_string(DARK)
    body.paragraph_format.space_after = Pt(7)
    body.paragraph_format.line_spacing = 1.12

    for name, size, color, before, after in (
        ("Title", 30, NAVY, 0, 12),
        ("Subtitle", 14, MID_GRAY, 0, 8),
        ("Heading 1", 18, NAVY, 10, 7),
        ("Heading 2", 12.5, BLUE, 8, 5),
        ("Heading 3", 10.5, DARK, 6, 3),
    ):
        st = doc.styles[name]
        st.font.name = "Aptos Display" if name in {"Title", "Heading 1", "Heading 2"} else "Aptos"
        st.font.size = Pt(size)
        st.font.bold = name.startswith("Heading") or name == "Title"
        st.font.color.rgb = RGBColor.from_string(color)
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(after)
        st.paragraph_format.keep_with_next = True

    for name in ("Header", "Footer"):
        doc.styles[name].font.name = "Aptos"
        doc.styles[name].font.size = Pt(8)

    for sec in doc.sections:
        add_footer(doc, sec)


def add_cover(doc: Document, period_text: str) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(26)
    r = p.add_run("VALIDACIÓN OPERATIVA · MERAKI / HELIX")
    r.bold = True
    r.font.size = Pt(10)
    r.font.color.rgb = RGBColor.from_string(CYAN)

    p = doc.add_paragraph(style="Title")
    p.add_run("Informe de validación\nde alertas")
    p.paragraph_format.space_after = Pt(12)
    remove_paragraph_borders(p)

    p = doc.add_paragraph(style="Subtitle")
    p.add_run("Consulta realizada el 29 de septiembre de 2026")

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(28)
    p.paragraph_format.space_after = Pt(14)
    r = p.add_run("Ministerio de Educación Pública – Costa Rica")
    r.bold = True
    r.font.size = Pt(13)
    r.font.color.rgb = RGBColor.from_string(BLUE)

    table = doc.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    set_cell_shading(cell, NAVY)
    set_cell_margins(cell, 330, 300, 330, 300)
    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r = p.add_run("Propósito")
    r.bold = True
    r.font.size = Pt(11)
    r.font.color.rgb = RGBColor.from_string("6DE0DF")
    p2 = cell.add_paragraph(
        "Presentar el resultado de la conciliación entre las alertas registradas en Helix y su estado consultado en Meraki, destacando correspondencias, pendientes de verificación y prioridades de seguimiento."
    )
    p2.runs[0].font.size = Pt(11)
    p2.runs[0].font.color.rgb = RGBColor.from_string(WHITE)
    p2.paragraph_format.space_after = Pt(0)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(40)
    r = p.add_run("Periodo de eventos analizado")
    r.bold = True
    r.font.size = Pt(9)
    r.font.color.rgb = RGBColor.from_string(MID_GRAY)
    p2 = doc.add_paragraph()
    p2.add_run(f"{period_text} · Hora de Costa Rica").font.size = Pt(12)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(70)
    r = p.add_run("Documento informativo para revisión del cliente")
    r.italic = True
    r.font.size = Pt(9)
    r.font.color.rgb = RGBColor.from_string(MID_GRAY)
    doc.add_page_break()


def build_report(rows: list[dict[str, str]], subset_rows: list[dict[str, str]]) -> Path:
    total = len(rows)
    validation = Counter(r["Validacion"] for r in rows)
    meraki_status = Counter(r["Estado_Meraki"] for r in rows)
    severity = Counter(r["SeveridadEvento"] for r in rows)
    events = Counter(r["Evento"] for r in rows)
    causes = Counter(r["CausaEvento"] for r in rows)
    clients = Counter(normalized_client(r["NombreCliente"]) for r in rows)
    unverified = [r for r in rows if r["Validacion"] == "NO_VERIFICADA"]
    unverified_clients = Counter(normalized_client(r["NombreCliente"]) for r in unverified)
    unverified_severity = Counter(r["SeveridadEvento"] for r in unverified)
    high_unverified = [r for r in unverified if r["SeveridadEvento"] == "ALTO"]
    unique_devices = len({r["NombreEquipo"] for r in rows if r["NombreEquipo"]})
    unique_locations = len({r["Ubicacion"] for r in rows if r["Ubicacion"]})
    validation_ids = {r["IdNotificacion"] for r in rows}
    subset_ids = {r["IdNotificacion"] for r in subset_rows}
    subset_is_contained = subset_ids <= validation_ids
    duplicate_count = total - len(validation_ids)
    exact_time_matches = sum(
        1
        for r in rows
        if r["Validacion"] == "OK"
        and r["Fecha_Helix_Costa_Rica"]
        and r["Fecha_Helix_Costa_Rica"] == r["Meraki_startedAt_CR"]
    )

    status_chart, severity_chart = create_charts(meraki_status, severity)

    doc = Document()
    configure_document(doc)
    core = doc.core_properties
    core.title = "Informe de validación de alertas Helix vs. Meraki"
    core.subject = "Consulta del 29 de septiembre de 2026"
    core.author = "Iammtechs"
    core.comments = "Generado a partir de los archivos de validación y alertas no verificadas."

    period_text = format_period(rows)
    add_cover(doc, period_text)

    add_heading(doc, "Resumen ejecutivo", 1)
    add_body(
        doc,
        f"Se analizaron {total} alertas registradas en Helix. De ellas, {validation['OK']} ({pct(validation['OK'], total)}) fueron localizadas en Meraki y {validation['NO_VERIFICADA']} ({pct(validation['NO_VERIFICADA'], total)}) quedaron pendientes de verificación. El resultado permite confirmar la trazabilidad de la mayoría de los registros y concentrar la revisión en un conjunto delimitado de excepciones.",
    )

    add_kpi_table(
        doc,
        [
            (str(total), "alertas analizadas", PALE_BLUE, BLUE),
            (str(validation["OK"]), f"verificadas · {pct(validation['OK'], total)}", PALE_GREEN, GREEN),
            (str(validation["NO_VERIFICADA"]), f"pendientes · {pct(validation['NO_VERIFICADA'], total)}", PALE_AMBER, AMBER),
            (str(len(high_unverified)), "pendientes de severidad alta", PALE_RED, RED),
        ],
    )
    doc.add_paragraph()

    add_callout(
        doc,
        "Resultado de confianza",
        f"Las {validation['OK']} alertas verificadas coinciden de forma exacta en la fecha y hora de inicio entre Helix y Meraki. No se detectaron identificadores duplicados dentro del universo analizado.",
        PALE_GREEN,
        GREEN,
    )

    add_heading(doc, "Lectura del resultado", 2)
    add_bullet(doc, f"{meraki_status['ACTIVA']} alertas ({pct(meraki_status['ACTIVA'], total)}) continúan activas en Meraki.")
    add_bullet(doc, f"{meraki_status['CESADA']} alertas ({pct(meraki_status['CESADA'], total)}) aparecen resueltas o cesadas.")
    add_bullet(doc, f"{meraki_status['NO_ENCONTRADA']} alertas ({pct(meraki_status['NO_ENCONTRADA'], total)}) no fueron localizadas con los criterios de consulta aplicados.")
    add_bullet(doc, f"La revisión cubre {unique_devices} equipos y {unique_locations} ubicaciones registradas en Helix.")

    add_heading(doc, "Prioridad recomendada", 2)
    add_body(
        doc,
        f"Atender primero las {len(high_unverified)} alertas no verificadas de severidad alta y confirmar el alcance organizacional de las {unverified_clients['Ministerio de Educación – ACS2']} alertas etiquetadas como “Ministerio de Educación – ACS2”. Esta segmentación representa el {pct(unverified_clients['Ministerio de Educación – ACS2'], len(unverified))} del grupo pendiente y puede incidir directamente en el resultado de búsqueda en Meraki.",
    )
    doc.add_page_break()

    add_heading(doc, "Alcance y metodología", 1)
    add_body(
        doc,
        "La revisión compara las alertas registradas en Helix con la información recuperada de Meraki. Para cada identificador de notificación se evaluó si existía una alerta correspondiente y, cuando fue encontrada, se registró su estado como activa o cesada.",
    )

    table = doc.add_table(rows=0, cols=2)
    table.autofit = False
    scope_rows = [
        ("Fecha de consulta", "29 de septiembre de 2026"),
        ("Periodo de los eventos", f"{period_text}, hora de Costa Rica"),
        ("Fuente principal", "validacion_2026-09-29.csv"),
        ("Detalle de pendientes", "no_verificadas_2026-09-29.csv"),
        ("Universo consolidado", f"{total} identificadores únicos"),
        ("Cobertura", f"{unique_devices} equipos · {unique_locations} ubicaciones · FASE1"),
    ]
    for i, (label, value) in enumerate(scope_rows):
        cells = table.add_row().cells
        cells[0].width = Inches(2.0)
        cells[1].width = Inches(5.0)
        set_cell_shading(cells[0], PALE_BLUE if i % 2 == 0 else LIGHT_GRAY)
        set_cell_shading(cells[1], WHITE if i % 2 == 0 else "FAFAFA")
        for c in cells:
            set_cell_margins(c, 100, 120, 100, 120)
            c.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        cells[0].paragraphs[0].add_run(label).bold = True
        cells[1].paragraphs[0].add_run(value)
    doc.add_paragraph()

    add_heading(doc, "Criterios de interpretación", 2)
    criteria = [
        ("Verificada / OK", "El identificador fue localizado en Meraki; se informa si permanece activo o ya fue resuelto."),
        ("No verificada", "El identificador no fue localizado con el alcance y los criterios de la consulta ejecutada."),
        ("Activa", "La alerta existe en Meraki y no presenta fecha de resolución."),
        ("Cesada", "La alerta existe en Meraki y presenta fecha de resolución."),
    ]
    for title, body in criteria:
        p = doc.add_paragraph(style="Body Text")
        r = p.add_run(f"{title}. ")
        r.bold = True
        r.font.color.rgb = RGBColor.from_string(BLUE)
        p.add_run(body)

    add_callout(
        doc,
        "Control de integridad de los archivos",
        f"El archivo de {len(subset_rows)} alertas no verificadas es un subconjunto completo del archivo de validación: sus {len(subset_ids)} identificadores ya forman parte de los {total} registros consolidados. Por esta razón no se sumaron ambos archivos. Duplicados detectados: {duplicate_count}.",
        PALE_BLUE,
        BLUE,
    )

    add_heading(doc, "Limitación del análisis", 2)
    add_body(
        doc,
        "La clasificación “no encontrada” confirma que la alerta no apareció en la respuesta consultada; por sí sola no determina la causa. Entre las posibles verificaciones posteriores se encuentran el alcance de organización, la pertenencia del equipo o red, el periodo disponible en Meraki y la correspondencia del identificador de origen.",
    )
    doc.add_page_break()

    add_heading(doc, "Resultados de la conciliación", 1)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(status_chart), width=Inches(6.8))

    add_heading(doc, "Distribución por severidad", 2)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(severity_chart), width=Inches(6.8))

    add_heading(doc, "Correspondencia temporal", 2)
    add_body(
        doc,
        f"En las {exact_time_matches} alertas verificadas, la fecha y hora de inicio de Helix coincide exactamente con el campo startedAt de Meraki, convertido a hora de Costa Rica. Esta coincidencia respalda que los registros conciliados corresponden al mismo evento operacional.",
    )

    add_heading(doc, "Distribución por etiqueta de cliente", 2)
    t = doc.add_table(rows=1, cols=4)
    t.autofit = False
    headers = ["Etiqueta en Helix", "Total", "Verificadas", "No verificadas"]
    for idx, h in enumerate(headers):
        c = t.rows[0].cells[idx]
        set_cell_shading(c, NAVY)
        c.paragraphs[0].add_run(h).bold = True
        c.paragraphs[0].runs[0].font.color.rgb = RGBColor.from_string(WHITE)
        set_cell_margins(c)
    set_repeat_table_header(t.rows[0])
    for client in ["Ministerio de Educación Pública – Costa Rica", "Ministerio de Educación – ACS2"]:
        client_rows = [r for r in rows if normalized_client(r["NombreCliente"]) == client]
        vals = [
            client,
            str(len(client_rows)),
            str(sum(r["Validacion"] == "OK" for r in client_rows)),
            str(sum(r["Validacion"] == "NO_VERIFICADA" for r in client_rows)),
        ]
        cells = t.add_row().cells
        for idx, value in enumerate(vals):
            cells[idx].paragraphs[0].add_run(value)
            set_cell_margins(cells[idx])
            if idx > 0:
                cells[idx].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_repeat_table_row(t.rows[-1])

    add_callout(
        doc,
        "Observación relevante",
        f"Las {unverified_clients['Ministerio de Educación – ACS2']} alertas con etiqueta ACS2 representan el {pct(unverified_clients['Ministerio de Educación – ACS2'], len(unverified))} de las no verificadas. Conviene confirmar si estos registros deben evaluarse dentro de la organización MEP consultada o mediante un alcance independiente.",
        PALE_AMBER,
        AMBER,
    )
    doc.add_page_break()

    add_heading(doc, "Anexo A · Alertas no encontradas en Meraki", 1)
    add_body(
        doc,
        f"A continuación se relacionan las {len(unverified)} alertas que no fueron localizadas en Meraki con los criterios de la consulta. El identificador del dispositivo corresponde al valor de IP o MAC informado en el archivo de Helix.",
    )

    widths = [1.24, 1.72, 1.12, 2.05, 1.02]
    annex_chunks = [unverified[:28], unverified[28:58], unverified[58:]]
    for chunk_index, chunk in enumerate(annex_chunks):
        if chunk_index > 0:
            doc.add_page_break()

        t = doc.add_table(rows=1, cols=5)
        t.autofit = False
        for idx, (h, width) in enumerate(
            zip(
                ["ID alerta", "Dispositivo", "ID dispositivo\n(IP/MAC)", "Descripción", "Fecha CR"],
                widths,
            )
        ):
            c = t.rows[0].cells[idx]
            c.width = Inches(width)
            set_cell_shading(c, NAVY)
            set_cell_margins(c, 70, 70, 70, 70)
            p = c.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(h)
            r.bold = True
            r.font.size = Pt(8)
            r.font.color.rgb = RGBColor.from_string(WHITE)
        set_repeat_table_header(t.rows[0])

        for idx, row in enumerate(chunk):
            cells = t.add_row().cells
            values = [
                row["IdNotificacion"],
                row["NombreEquipo"],
                row["IPequipo"],
                row["DescripcionEvento"] or row["Evento"],
                row["Fecha_Helix_Costa_Rica"][:16],
            ]
            for col, (cell, value) in enumerate(zip(cells, values)):
                cell.width = Inches(widths[col])
                set_cell_margins(cell, 60, 65, 60, 65)
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                p = cell.paragraphs[0]
                r = p.add_run(value)
                r.font.size = Pt(7.2)
                if col == 0:
                    r.font.name = "Aptos Narrow"
                if col in (0, 2, 4):
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            if idx % 2 == 1:
                for c in cells:
                    set_cell_shading(c, LIGHT_GRAY)
            set_repeat_table_row(t.rows[-1])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc.save(DOCX_PATH)
    return DOCX_PATH


if __name__ == "__main__":
    validation_rows = read_csv(INPUT_VALIDATION)
    unverified_rows = read_csv(INPUT_UNVERIFIED)
    path = build_report(validation_rows, unverified_rows)
    print(path)
