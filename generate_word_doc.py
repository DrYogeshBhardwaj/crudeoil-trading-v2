import os
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tcPr.append(shd)

def create_word_document(output_path):
    doc = Document()

    # Set Margins (1 inch all around)
    sections = doc.sections
    for section in sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)

    # Document Title
    p_title = doc.add_paragraph()
    run_title = p_title.add_run("SubhMani BTC Automated Pair Trading Engine\nComplete Architecture, Capital & Operations Guide")
    run_title.font.name = "Calibri"
    run_title.font.size = Pt(24)
    run_title.font.bold = True
    run_title.font.color.rgb = RGBColor(15, 23, 42)
    p_title.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # Subtitle / Metadata
    p_sub = doc.add_paragraph()
    r_sub = p_sub.add_run("A Quantitative Framework for Delta-Neutral Pair Scalping, 15x Leverage Margin Management, and Automated Punarjanm Rebirth Cycles.")
    r_sub.font.name = "Calibri"
    r_sub.font.size = Pt(12)
    r_sub.font.italic = True
    r_sub.font.color.rgb = RGBColor(100, 116, 139)

    doc.add_paragraph("―" * 55)

    # 1. Executive Summary
    h1 = doc.add_heading("1. Executive Summary", level=1)
    h1.style.font.name = "Calibri"
    h1.style.font.color.rgb = RGBColor(15, 23, 42)

    doc.add_paragraph(
        "SubhMani BTC Automated Pair Trading Engine ek institutional-grade algorithmic software hai jo "
        "Bitcoin Perpetual Futures (BTCUSDT) market me Mudrex Exchange ke sath directly integrate hokar kaam karta hai. "
        "Yeh software market ke direction (Bullish ya Bearish) par depend kiye bina simultaneous Buy aur Sell positions "
        "(Dual-Hedged Pair Model) create karta hai aur predetermined price movement targets par continuous net profit book karta hai."
    )

    doc.add_paragraph(
        "Key Innovations:\n"
        "• Pure Delta-Neutral Pair Model: Market upar jaye ya neeche, ek leg lagatar profit target lock karti rehti hai.\n"
        "• Automated Punarjanm (Rebirth Cycles): Har milestone par profit ko bank/wallet balance me secure karke fresh trade grid open karna.\n"
        "• Authoritative 1:1 Live Mudrex Sync: Mudrex Futures Wallet, Locked Margin, aur Est. Total Portfolio ka real-time balance reconciliation."
    )

    # 2. Capital Sizing & Starting Requirements
    h2 = doc.add_heading("2. Capital Requirements & Account Sizing (Kitna Amount Chahiye?)", level=1)
    doc.add_paragraph(
        "Engine ko run karne ke liye capital ko do hisso me baanta jata hai:\n"
        "1. Initial Margin Held: Mudrex 15x leverage par jo contract margin lock karta hai.\n"
        "2. Safe Cash Cushion (Free Margin): Market ke adverse fluctuation aur drawdown ko bina liquidation ke absorb karne ke liye bacha hua balance."
    )

    # Table of Capital Requirements
    table = doc.add_table(rows=4, cols=6)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False

    headers = ["Trading Level", "Lot Size", "Pairs", "Exchange Margin (15x)", "Safe Cushion", "Total Capital Needed"]
    for i, h in enumerate(headers):
        cell = table.cell(0, i)
        cell.text = h
        set_cell_background(cell, "1E293B")
        for p in cell.paragraphs:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for r in p.runs:
                r.font.bold = True
                r.font.size = Pt(10)
                r.font.color.rgb = RGBColor(255, 255, 255)

    rows_data = [
        ["Testing / Micro", "0.01 BTC", "1 Pair", "₹11,150", "₹10,000", "₹20,000 – ₹25,000"],
        ["Standard Starter", "0.02 BTC", "1 Pair", "₹22,300", "₹15,000", "₹37,000 – ₹40,000"],
        ["🌟 Golden Sweet Spot", "0.02 BTC", "2 Pairs", "₹44,600", "₹30,000", "₹75,000 – ₹85,000"]
    ]

    for r_idx, r_data in enumerate(rows_data):
        row = table.rows[r_idx + 1]
        for c_idx, val in enumerate(r_data):
            cell = row.cells[c_idx]
            cell.text = val
            bg = "F1F5F9" if r_idx % 2 == 0 else "FFFFFF"
            set_cell_background(cell, bg)
            for p in cell.paragraphs:
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                for r in p.runs:
                    r.font.size = Pt(9.5)
                    if c_idx == 0 or c_idx == 5:
                        r.font.bold = True
                        r.font.color.rgb = RGBColor(15, 23, 42)

    doc.add_paragraph().space_after = Pt(12)

    # 3. Why ₹85,000 - ₹1,00,000 is the Best Capital?
    h3 = doc.add_heading("3. Golden Recommendation: ₹85,000 se ₹1,00,000", level=1)
    doc.add_paragraph(
        "Quantitative analysis aur historical backtest models (btc-compare) ke mutabik, ₹85,000 se ₹1,00,000 "
        "ka capital 'Sweet Spot' maana jata hai kyunki:\n\n"
        "1. Comfortable 2-Pair Execution: 0.02 BTC ke 2 full pairs (4 legs) chalane ke liye ₹44,600 margin lock hota hai. "
        "Aapke account me fir bhi ₹40,000+ ka unallocated free cash margin available rehta hai.\n"
        "2. Large Adverse Buffering: Bitcoin me $1,000 se $1,500 tak ke wild spikes aane par bhi portfolio par koi stress nahi aata.\n"
        "3. Faster Punarjanm Frequency: 2 pairs simultaneously scalping karne se ₹1,000 – ₹3,000 ke profit targets fast frequency se hit hote hain, "
        "jisse monthly returns consistent aur predictable bante hain."
    )

    # 4. Mudrex Wallet Demystified
    h4 = doc.add_heading("4. Mudrex Wallet Architecture (Spot vs Futures)", level=1)
    doc.add_paragraph(
        "Mudrex platform par do alag-alag wallets hote hain jinka role samajhna behad zaroori hai:\n\n"
        "• INR Funds (Spot Wallet): Yeh aapka primary bank savings fund hota hai (e.g. ₹13,227.28). "
        "Is wallet me rakhe paise par trading risk nahi hota.\n"
        "• INR Futures Wallet: Saari perpetual futures trading isi wallet se hoti hai (e.g. ₹87,396.50). "
        "Trading ka saara net profit seedhe isi wallet me credit hota hai.\n"
        "• Consolidated Net Worth: Dono wallets ko mila kar Mudrex dashboard par 'Est. Total Value' ₹1,00,623.78 show hota hai.\n\n"
        "Jab user chahe, 'INR Futures Transfer' button se Futures ka munafa Spot wallet me move karke bank account me withdraw kar sakta hai."
    )

    # 5. Risk Management Shield
    h5 = doc.add_heading("5. Risk Management & Safety Shield", level=1)
    doc.add_paragraph(
        "Engine me built-in multi-layered safety mechanisms hain:\n"
        "1. Dynamic Margin Check: Har trade open karne se pehle free cash buffer check hota hai. Margin short hone par order drop ho jata hai.\n"
        "2. One-Way Netting Compliance: Mudrex exchange orderbook rules ko strictly follow kiya jata hai taaki exchange rejection na ho.\n"
        "3. Automatic Take-Profit (TP): Har order fill hote hi exchange par matching exit order turant place ho jata hai.\n"
        "4. Seed-Backed Crash Resilience: Server restart ya container redeployment par real positions aur closed history kabhi wipe nahi hoti."
    )

    # 6. Conclusion
    h6 = doc.add_heading("6. Conclusion & Pitch Deck Summary", level=1)
    doc.add_paragraph(
        "SubhMani BTC Pair Trading Engine kisi bhi investor ya client ke liye ek hands-free, mathematically proven, "
        "aur high-safety solution provide karta hai. Is model ko samjhane ke liye 3 main baatein batana kaafi hai:\n"
        "• Minimum Start: ₹35,000 (1 Pair)\n"
        "• Recommended Golden Setup: ₹85,000 (2 Pairs)\n"
        "• Safety: Automatic 15x buffer with instant TP locking on Mudrex"
    )

    doc.save(output_path)
    print(f"Word Document saved successfully to: {output_path}")

if __name__ == '__main__':
    out_dir = r"c:\SinaankProjects\Mudrex LIVE Rate Trading Engine\docs"
    os.makedirs(out_dir, exist_ok=True)
    create_word_document(os.path.join(out_dir, "BTC_Pair_Trading_Engine_Investor_Guide.docx"))
