import os
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.graphics.shapes import Drawing, Rect, String, Line

def create_guide_pdf(filename):
    doc = SimpleDocTemplate(
        filename,
        pagesize=letter,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36
    )

    BG_COLOR = colors.HexColor("#060D06")
    CARD_BG = colors.HexColor("#0D1D0D")
    BORDER_COLOR = colors.HexColor("#1A331A")
    CYAN_ACCENT = colors.HexColor("#00F2FF")
    EMERALD_ACCENT = colors.HexColor("#00FF9D")
    TEXT_WHITE = colors.HexColor("#F0F5F0")
    TEXT_MUTED = colors.HexColor("#8AA08A")

    styles = getSampleStyleSheet()

    # Base Styles
    styles.add(ParagraphStyle(
        name="DocTitle",
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=26,
        textColor=CYAN_ACCENT,
        spaceAfter=4
    ))

    styles.add(ParagraphStyle(
        name="DocSubtitle",
        fontName="Helvetica",
        fontSize=11,
        leading=15,
        textColor=TEXT_MUTED,
        spaceAfter=12
    ))

    styles.add(ParagraphStyle(
        name="SectionHeader",
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=17,
        textColor=EMERALD_ACCENT,
        spaceBefore=10,
        spaceAfter=6
    ))

    styles.add(ParagraphStyle(
        name="StepTitle",
        fontName="Helvetica-Bold",
        fontSize=10.5,
        leading=14,
        textColor=CYAN_ACCENT,
        spaceAfter=4
    ))

    styles.add(ParagraphStyle(
        name="BodyTextCustom",
        fontName="Helvetica",
        fontSize=9.5,
        leading=13.5,
        textColor=TEXT_WHITE,
        spaceAfter=5
    ))

    styles.add(ParagraphStyle(
        name="MutedBodyText",
        fontName="Helvetica",
        fontSize=9,
        leading=13,
        textColor=TEXT_MUTED,
        spaceAfter=4
    ))

    story = []

    # Header Title Banner
    story.append(Paragraph("MOONPOND SUITE · LOOPLAYER AESTHETIC", ParagraphStyle("SubTag", fontName="Helvetica-Bold", fontSize=9, textColor=EMERALD_ACCENT, spaceAfter=2)))
    story.append(Paragraph("Multitrack Video & Audio Layering Guide", styles["DocTitle"]))
    story.append(Paragraph("Step-by-Step Operating Manual & Time Envelope Workflow", styles["DocSubtitle"]))
    story.append(HRFlowable(width="100%", thickness=1, color=BORDER_COLOR, spaceAfter=12))

    # Core Philosophy Box
    intro_p = Paragraph(
        "<b>Core Architecture:</b> LoopLayer Aesthetic operates on a <b>Phase-Locked Master Loop Cycle</b>. "
        "Layer 1 establishes the fixed master duration <i>(D)</i> and tempo. All subsequent layers (Layer 2..N) "
        "record freely overdubbed takes, allowing you to slide a constant length-<i>(D)</i> Time Envelope to extract "
        "your best phrase while discarding extra tail audio/video. The entire stack loops continuously in sync.",
        styles["BodyTextCustom"]
    )
    
    intro_table = Table([[intro_p]], colWidths=[540])
    intro_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), CARD_BG),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('PADDING', (0,0), (-1,-1), 9),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    story.append(intro_table)
    story.append(Spacer(1, 10))

    # SECTION 1: MASTER LOOP
    story.append(Paragraph("Phase 1: Setting the Master Loop (Layer 1)", styles["SectionHeader"]))

    s1_text = Paragraph(
        "<b>1. Tap Record:</b> Begins capturing your initial video & audio take from the camera view.<br/>"
        "<b>2. Tap Stop:</b> Stops recording. The raw clip immediately starts looping in preview.<br/>"
        "<b>3. Adjust Trim Handles:</b> Set the initial loop start and end boundaries to define Master Duration <i>(D)</i>.<br/>"
        "<b>4. Confirm Master Loop:</b> Tapping confirm locks in <i>D</i> and starts clock playback. Layer 1 loops infinitely on the video stack.",
        styles["BodyTextCustom"]
    )
    
    s1_table = Table([[s1_text]], colWidths=[540])
    s1_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), CARD_BG),
        ('LINELEFT', (0,0), (0,-1), 3, CYAN_ACCENT),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('PADDING', (0,0), (-1,-1), 9),
    ]))
    story.append(s1_table)
    story.append(Spacer(1, 10))

    # SECTION 2: OVERDUBBING & TIME ENVELOPE
    story.append(Paragraph("Phase 2: Overdubbing & Time Envelope (Layer 2..N)", styles["SectionHeader"]))

    s2_text = Paragraph(
        "<b>1. Tap Record WHILE Stack Plays:</b> You do <i>not</i> need to pause playback. Pressing Record arms the system.<br/>"
        "<b>2. Quantized Start:</b> The Record button glows yellow in <b>ARMED</b> state. It waits for the loop restart boundary (0ms) "
        "and automatically starts recording at the exact instant the loop repeats.<br/>"
        "<b>3. Perform Overdub:</b> Record your new vocal or instrument layer while hearing and seeing all prior layers loop in perfect sync.<br/>"
        "<b>4. Tap Stop:</b> Recording finishes.<br/>"
        "<b>5. Move the Time Envelope:</b> A fixed window of length <i>D</i> is placed over your raw recording. Drag the envelope left or right "
        "to choose the exact portion of your recording to keep.<br/>"
        "<b>6. Confirm Phrase:</b> The portion inside the envelope joins the active stack; all extra footage outside the envelope is removed.",
        styles["BodyTextCustom"]
    )

    s2_table = Table([[s2_text]], colWidths=[540])
    s2_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), CARD_BG),
        ('LINELEFT', (0,0), (0,-1), 3, EMERALD_ACCENT),
        ('BOX', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('PADDING', (0,0), (-1,-1), 9),
    ]))
    story.append(s2_table)
    story.append(Spacer(1, 10))

    # SECTION 3: WORKFLOW CHEAT SHEET TABLE
    story.append(Paragraph("Quick Workflow Summary & Control Matrix", styles["SectionHeader"]))

    table_data = [
        [
            Paragraph("<b>Action / Phase</b>", styles["StepTitle"]),
            Paragraph("<b>System Behavior</b>", styles["StepTitle"]),
            Paragraph("<b>Musician Outcome</b>", styles["StepTitle"])
        ],
        [
            Paragraph("<b>Press Record (Layer 1)</b>", styles["BodyTextCustom"]),
            Paragraph("Starts capturing video & audio immediately.", styles["MutedBodyText"]),
            Paragraph("Performs initial baseline phrase.", styles["BodyTextCustom"])
        ],
        [
            Paragraph("<b>Press Stop (Layer 1)</b>", styles["BodyTextCustom"]),
            Paragraph("Opens Trim Editor with initial handles.", styles["MutedBodyText"]),
            Paragraph("Selects initial loop length <i>D</i>.", styles["BodyTextCustom"])
        ],
        [
            Paragraph("<b>Press Record (Layer N)</b>", styles["BodyTextCustom"]),
            Paragraph("Arms and waits for loop 0ms boundary tick.", styles["MutedBodyText"]),
            Paragraph("Seamless quantized start without stopping playback.", styles["BodyTextCustom"])
        ],
        [
            Paragraph("<b>Press Stop (Layer N)</b>", styles["BodyTextCustom"]),
            Paragraph("Opens Timeline Browser with fixed <i>D</i> envelope.", styles["MutedBodyText"]),
            Paragraph("Slides envelope to select best take section.", styles["BodyTextCustom"])
        ],
        [
            Paragraph("<b>Confirm Envelope</b>", styles["BodyTextCustom"]),
            Paragraph("Trims unselected footage; adds layer to stack.", styles["MutedBodyText"]),
            Paragraph("Layer joins live mix; Record offered again.", styles["BodyTextCustom"])
        ],
    ]

    matrix_table = Table(table_data, colWidths=[135, 200, 205])
    matrix_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#142914")),
        ('GRID', (0,0), (-1,-1), 1, BORDER_COLOR),
        ('BACKGROUND', (0,1), (-1,-1), CARD_BG),
        ('PADDING', (0,0), (-1,-1), 6),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ]))
    story.append(matrix_table)
    story.append(Spacer(1, 10))

    # Footer note
    story.append(HRFlowable(width="100%", thickness=1, color=BORDER_COLOR, spaceAfter=8))
    story.append(Paragraph(
        "<b>LoopLayer Aesthetic</b> · Developed by Moonpond DeepMind Agentic Coding Team · Built with Expo SDK 57 & Native Audio/Video Engine",
        ParagraphStyle("FooterText", fontName="Helvetica", fontSize=8, textColor=TEXT_MUTED, alignment=1)
    ))

    def paint_background(canvas, document):
        canvas.saveState()
        canvas.setFillColor(BG_COLOR)
        canvas.rect(0, 0, document.pagesize[0], document.pagesize[1], fill=True, stroke=False)
        canvas.restoreState()

    doc.build(story, onFirstPage=paint_background, onLaterPages=paint_background)
    print(f"Guide PDF generated at {filename}")

if __name__ == "__main__":
    out_path = "/Users/stevenjackson/Desktop/CURRENT VERSIONS/Aesthetic/LoopLayer_User_Guide.pdf"
    create_guide_pdf(out_path)
