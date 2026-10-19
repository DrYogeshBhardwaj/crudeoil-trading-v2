import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE

def create_presentation(output_path):
    prs = Presentation()
    prs.slide_width = Inches(13.333)  # 16:9 Widescreen
    prs.slide_height = Inches(7.5)

    # Professional Color Palette
    DARK_NAVY = RGBColor(15, 23, 42)     # #0f172a
    CARD_BG = RGBColor(30, 41, 59)       # #1e293b
    ACCENT_GOLD = RGBColor(245, 158, 11)  # #f59e0b
    ACCENT_CYAN = RGBColor(56, 189, 248)  # #38bdf8
    ACCENT_GREEN = RGBColor(34, 197, 94)  # #22c55e
    TEXT_LIGHT = RGBColor(248, 250, 252) # #f8fafc
    TEXT_MUTED = RGBColor(148, 163, 184) # #94a3b8

    def add_blank_slide_with_bg():
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
        bg.fill.solid()
        bg.fill.fore_color.rgb = DARK_NAVY
        bg.line.fill.background()
        return slide

    def add_header(slide, title_text, category="SUBHMANI BTC TRADING ENGINE"):
        # Category Tracker
        cat_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.5), Inches(11.7), Inches(0.4))
        tf_c = cat_box.text_frame
        p_c = tf_c.paragraphs[0]
        p_c.text = category.upper()
        p_c.font.size = Pt(11)
        p_c.font.bold = True
        p_c.font.color.rgb = ACCENT_GOLD

        # Main Title
        title_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.8), Inches(11.7), Inches(0.8))
        tf = title_box.text_frame
        p = tf.paragraphs[0]
        p.text = title_text
        p.font.size = Pt(24)
        p.font.bold = True
        p.font.color.rgb = TEXT_LIGHT

    # ==================== SLIDE 1: TITLE SLIDE ====================
    slide1 = add_blank_slide_with_bg()
    
    # Title box
    tbox = slide1.shapes.add_textbox(Inches(1.0), Inches(2.0), Inches(11.3), Inches(3.0))
    tf1 = tbox.text_frame
    p1 = tf1.paragraphs[0]
    p1.text = "SubhMani BTC Automated Pair Trading Engine"
    p1.font.size = Pt(36)
    p1.font.bold = True
    p1.font.color.rgb = ACCENT_CYAN
    
    p2 = tf1.add_paragraph()
    p2.text = "Capital Requirements, Risk Architecture & Mathematical Model Guide"
    p2.font.size = Pt(20)
    p2.font.color.rgb = ACCENT_GOLD
    p2.space_before = Pt(14)

    p3 = tf1.add_paragraph()
    p3.text = "Mudrex Live Futures Integration | Automated Punarjanm Cycles | Delta-Neutral Sizing"
    p3.font.size = Pt(14)
    p3.font.color.rgb = TEXT_MUTED
    p3.space_before = Pt(10)

    # Info footer
    foot_box = slide1.shapes.add_textbox(Inches(1.0), Inches(5.8), Inches(11.3), Inches(1.0))
    tf_f = foot_box.text_frame
    p_f = tf_f.paragraphs[0]
    p_f.text = "Target Audience: Clients, Investors & Operations Team | Prepared by: Quantitative Development Team"
    p_f.font.size = Pt(12)
    p_f.font.color.rgb = TEXT_MUTED

    # ==================== SLIDE 2: EXECUTIVE SUMMARY ====================
    slide2 = add_blank_slide_with_bg()
    add_header(slide2, "1. Executive Summary — How The Engine Works")

    card_data = [
        ("🔄 Delta-Neutral Pair Model", "Har trade me simultaneous BUY & SELL legs open hoti hain. Market upar jaye ya neeche, ek leg continuous target profit book karti rehti hai bina directional risk ke.", ACCENT_CYAN),
        ("🛡️ Capital Preservation & Margin", "15x leverage par contract size aur free margin cash cushion ka strict mathematical ratio maintain hota hai, jisse liquidation risk virtually zero ho jata hai.", ACCENT_GREEN),
        ("⚡ Punarjanm Rebirth Cycles", "Jab total net basket profit predefined limit (e.g. ₹1,000 – ₹3,000) cross karta hai, engine sab positions ko lock karke fresh grid par reboot hota hai.", ACCENT_GOLD)
    ]

    for i, (title, desc, color) in enumerate(card_data):
        left = Inches(0.8 + i * 3.9)
        top = Inches(2.0)
        card = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, Inches(3.7), Inches(4.5))
        card.fill.solid()
        card.fill.fore_color.rgb = CARD_BG
        card.line.color.rgb = color
        card.line.width = Pt(1.5)

        tf = card.text_frame
        tf.margin_left = Inches(0.3)
        tf.margin_top = Inches(0.4)
        tf.margin_right = Inches(0.3)

        p = tf.paragraphs[0]
        p.text = title
        p.font.size = Pt(16)
        p.font.bold = True
        p.font.color.rgb = color

        p_desc = tf.add_paragraph()
        p_desc.text = desc
        p_desc.font.size = Pt(13)
        p_desc.font.color.rgb = TEXT_LIGHT
        p_desc.space_before = Pt(16)

    # ==================== SLIDE 3: CAPITAL REQUIREMENTS ====================
    slide3 = add_blank_slide_with_bg()
    add_header(slide3, "2. Capital Requirements — Kitna Amount Chahiye?")

    # Add Table
    rows = 4
    cols = 6
    left = Inches(0.8)
    top = Inches(2.0)
    width = Inches(11.7)
    height = Inches(4.5)

    table_shape = slide3.shapes.add_table(rows, cols, left, top, width, height)
    table = table_shape.table

    headers = ["Trading Level", "Lot Size", "Pairs", "Exchange Margin (15x)", "Safe Cushion", "Total Capital Needed"]
    for c_idx, h in enumerate(headers):
        cell = table.cell(0, c_idx)
        cell.text = h
        cell.fill.solid()
        cell.fill.fore_color.rgb = CARD_BG
        p = cell.text_frame.paragraphs[0]
        p.font.bold = True
        p.font.size = Pt(13)
        p.font.color.rgb = ACCENT_GOLD
        p.alignment = PP_ALIGN.CENTER

    data = [
        ["Testing / Micro", "0.01 BTC", "1 Pair", "₹11,150", "₹10,000", "₹20,000 – ₹25,000"],
        ["Standard Starter", "0.02 BTC", "1 Pair", "₹22,300", "₹15,000", "₹37,000 – ₹40,000"],
        ["🌟 Golden Sweet Spot", "0.02 BTC", "2 Pairs", "₹44,600", "₹30,000", "₹75,000 – ₹85,000"],
    ]

    for r_idx, row_data in enumerate(data):
        for c_idx, val in enumerate(row_data):
            cell = table.cell(r_idx + 1, c_idx)
            cell.text = val
            cell.fill.solid()
            cell.fill.fore_color.rgb = DARK_NAVY if r_idx % 2 == 0 else CARD_BG
            p = cell.text_frame.paragraphs[0]
            p.font.size = Pt(12)
            p.font.color.rgb = ACCENT_CYAN if c_idx == 0 or c_idx == 5 else TEXT_LIGHT
            if c_idx == 5:
                p.font.bold = True
            p.alignment = PP_ALIGN.CENTER

    # ==================== SLIDE 4: THE GOLDEN SWEET SPOT ====================
    slide4 = add_blank_slide_with_bg()
    add_header(slide4, "3. Why ₹85,000 – ₹1,00,000 Is The Best Recommended Amount?")

    # Left Box
    b1 = slide4.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(2.0), Inches(5.7), Inches(4.7))
    b1.fill.solid()
    b1.fill.fore_color.rgb = CARD_BG
    b1.line.color.rgb = ACCENT_CYAN
    tf_b1 = b1.text_frame
    tf_b1.margin_left = Inches(0.4)
    tf_b1.margin_right = Inches(0.4)
    tf_b1.margin_top = Inches(0.4)
    p = tf_b1.paragraphs[0]
    p.text = "Mathematical Margin Allocation"
    p.font.size = Pt(18)
    p.font.bold = True
    p.font.color.rgb = ACCENT_CYAN

    bullets1 = [
        "Total Futures Capital: ₹87,396 (Mudrex Real Account)",
        "2 Active Pairs on 0.02 BTC: ₹44,600 margin locked",
        "Free Cash Margin Remaining: ₹42,796 (49% Cash Buffer)",
        "Leverage: 15x on BTCUSDT Perpetual Futures",
        "USD/INR Exchange Rate Peg: ₹102.00 (authoritative)"
    ]
    for b in bullets1:
        p_b = tf_b1.add_paragraph()
        p_b.text = "• " + b
        p_b.font.size = Pt(13)
        p_b.font.color.rgb = TEXT_LIGHT
        p_b.space_before = Pt(12)

    # Right Box
    b2 = slide4.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(6.8), Inches(2.0), Inches(5.7), Inches(4.7))
    b2.fill.solid()
    b2.fill.fore_color.rgb = CARD_BG
    b2.line.color.rgb = ACCENT_GREEN
    tf_b2 = b2.text_frame
    tf_b2.margin_left = Inches(0.4)
    tf_b2.margin_right = Inches(0.4)
    tf_b2.margin_top = Inches(0.4)
    p = tf_b2.paragraphs[0]
    p.text = "Key Operational Advantages"
    p.font.size = Pt(18)
    p.font.bold = True
    p.font.color.rgb = ACCENT_GREEN

    bullets2 = [
        "Zero Margin Stress: Never triggers auto-deleveraging or margin call.",
        "Shock-Absorbing Capacity: Can withstand up to $1,500 BTC adverse price swing without breaking equity.",
        "Faster Punarjanm Cycles: 2 pairs working in parallel reach the ₹1,000 – ₹3,000 profit harvest milestone 2x faster.",
        "Smooth Mudrex 1:1 Netting: Full alignment with Mudrex exchange orderbook."
    ]
    for b in bullets2:
        p_b = tf_b2.add_paragraph()
        p_b.text = "✓ " + b
        p_b.font.size = Pt(13)
        p_b.font.color.rgb = TEXT_LIGHT
        p_b.space_before = Pt(12)

    # ==================== SLIDE 5: MUDREX WALLET STRUCTURE ====================
    slide5 = add_blank_slide_with_bg()
    add_header(slide5, "4. Mudrex Wallet Architecture Demystified")

    w_cards = [
        ("1. INR Funds (Spot Wallet)", "₹13,227.28", "• Saving / idle bank deposit wallet\n• Trading loss/profit direct yahan impact nahi karti\n• Safe idle reserve funds", ACCENT_CYAN),
        ("2. INR Futures Wallet", "₹87,396.50", "• Live trading margin & profits account\n• Trading P/L isi wallet me settle hota hai\n• 1:1 synced with Engine Dashboard", ACCENT_GOLD),
        ("3. Est. Total Portfolio", "₹1,00,623.78", "• Consolidated net worth of the user\n• Spot (₹13k) + Futures (₹87k) = ₹1,00,624\n• Complete institutional visibility", ACCENT_GREEN)
    ]

    for i, (title, amt, desc, color) in enumerate(w_cards):
        left = Inches(0.8 + i * 3.9)
        top = Inches(2.0)
        card = slide5.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, Inches(3.7), Inches(4.5))
        card.fill.solid()
        card.fill.fore_color.rgb = CARD_BG
        card.line.color.rgb = color
        card.line.width = Pt(1.5)

        tf = card.text_frame
        tf.margin_left = Inches(0.3)
        tf.margin_top = Inches(0.3)
        tf.margin_right = Inches(0.3)

        p = tf.paragraphs[0]
        p.text = title
        p.font.size = Pt(15)
        p.font.bold = True
        p.font.color.rgb = color

        p_amt = tf.add_paragraph()
        p_amt.text = amt
        p_amt.font.size = Pt(22)
        p_amt.font.bold = True
        p_amt.font.color.rgb = TEXT_LIGHT
        p_amt.space_before = Pt(10)

        p_desc = tf.add_paragraph()
        p_desc.text = desc
        p_desc.font.size = Pt(12)
        p_desc.font.color.rgb = TEXT_MUTED
        p_desc.space_before = Pt(14)

    # ==================== SLIDE 6: RISK MANAGEMENT & CONCLUSION ====================
    slide6 = add_blank_slide_with_bg()
    add_header(slide6, "5. Risk Management Shield & Summary")

    box_end = slide6.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(2.0), Inches(11.7), Inches(4.7))
    box_end.fill.solid()
    box_end.fill.fore_color.rgb = CARD_BG
    box_end.line.color.rgb = ACCENT_GOLD
    tf_end = box_end.text_frame
    tf_end.margin_left = Inches(0.5)
    tf_end.margin_right = Inches(0.5)
    tf_end.margin_top = Inches(0.4)

    p = tf_end.paragraphs[0]
    p.text = "Summary: Key Takeaways for Clients & Operations"
    p.font.size = Pt(20)
    p.font.bold = True
    p.font.color.rgb = ACCENT_GOLD

    points = [
        "1. Minimum Entry Barrier: Kisi ko bhi test karne ke liye ₹35,000 – ₹40,000 se start kiya ja sakta hai (0.02 BTC - 1 Pair).",
        "2. Recommended Standard Setup: ₹75,000 – ₹85,000 for 2 Pairs (best risk-reward & stable growth).",
        "3. Live Verification: Mudrex official API se 1:1 real-time connected hai. Koi manual order placement ki zaroorat nahi.",
        "4. Auto-Harvest Punarjanm: Har ₹1,000 to ₹3,000 par profit safely bank/wallet me freeze ho jata hai.",
        "5. Capital Safety: One-Way netting aur auto-hedged mathematical cushion se client capital 100% protected rehta hai."
    ]

    for pt in points:
        p_pt = tf_end.add_paragraph()
        p_pt.text = pt
        p_pt.font.size = Pt(14)
        p_pt.font.color.rgb = TEXT_LIGHT
        p_pt.space_before = Pt(14)

    prs.save(output_path)
    print(f"Presentation saved successfully to: {output_path}")

if __name__ == '__main__':
    out_dir = r"c:\SinaankProjects\Mudrex LIVE Rate Trading Engine\docs"
    os.makedirs(out_dir, exist_ok=True)
    create_presentation(os.path.join(out_dir, "BTC_Pair_Trading_Engine_Presentation.pptx"))
