"""Generate NDA DOCX for iOS developer engagement (KFIVE)."""
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "legal" / "NDA-iOS-Developer.docx"

COMPANY = {
    "legal_name": "KFIVE DI CHIOZZA GIOVANNI S.A.S.",
    "address": "Via Pasini 15, 36015 Schio (VI), Italy",
    "vat": "03468110246",
    "tax_code": "03468110246",
    "representative": "Giovanni Chiozza",
    "email": "",  # fill before sending if desired
    "jurisdiction": "Vicenza, Italy",
}


def blank_line(doc: Document, label: str, width: int = 60) -> None:
    p = doc.add_paragraph()
    run = p.add_run(f"{label} ")
    run.bold = True
    p.add_run("_" * width)


def filled_line(doc: Document, label: str, value: str) -> None:
    p = doc.add_paragraph()
    run = p.add_run(f"{label} ")
    run.bold = True
    p.add_run(value)


def body(doc: Document, text: str) -> None:
    p = doc.add_paragraph(text)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.line_spacing = 1.15


def heading(doc: Document, text: str, level: int = 1) -> None:
    doc.add_heading(text, level=level)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)

    doc = Document()
    section = doc.sections[0]
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    tr = title.add_run("NON-DISCLOSURE AGREEMENT")
    tr.bold = True
    tr.font.size = Pt(16)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sr = subtitle.add_run(
        "(Unilateral — iOS Migration of Business Scanner Application)"
    )
    sr.italic = True
    sr.font.size = Pt(11)

    doc.add_paragraph()

    body(
        doc,
        'This Non-Disclosure Agreement ("Agreement") is entered into as of the date '
        'last signed below ("Effective Date"), by and between the parties identified below.',
    )

    heading(doc, "1. Parties", 2)

    body(doc, '1.1 Disclosing Party ("Company"):')
    filled_line(doc, "Legal name:", COMPANY["legal_name"])
    filled_line(doc, "Registered office:", COMPANY["address"])
    filled_line(doc, "VAT number (P. IVA):", COMPANY["vat"])
    filled_line(doc, "Tax code (Codice fiscale):", COMPANY["tax_code"])
    filled_line(doc, "Represented by:", COMPANY["representative"])
    if COMPANY["email"]:
        filled_line(doc, "Email:", COMPANY["email"])
    else:
        blank_line(doc, "Email:", 56)

    doc.add_paragraph()
    body(
        doc,
        '1.2 Receiving Party ("Developer") — independent freelancer based in Pakistan:',
    )
    blank_line(doc, "Full legal name:", 50)
    filled_line(doc, "Status:", "Independent freelancer (individual, not a company)")
    blank_line(doc, "Residential address:", 46)
    filled_line(doc, "Country:", "Pakistan")
    blank_line(doc, "Email:", 56)
    blank_line(doc, "CNIC / National ID (if applicable):", 36)
    blank_line(doc, "NTN / Tax ID (if applicable):", 40)

    heading(doc, "2. Background and Purpose", 2)
    body(
        doc,
        'The Company has developed a mobile application known as "Business Scanner" '
        '(the "Application"), currently available on Android, built with Expo / React Native. '
        "The Company wishes to engage the Developer, as an independent contractor, to migrate, "
        "adapt, build, test, and/or submit the Application for iOS (including App Store / "
        "TestFlight distribution), and may disclose Confidential Information (defined below) "
        'for that purpose only (the "Purpose").',
    )

    heading(doc, "3. Confidential Information", 2)
    body(
        doc,
        '"Confidential Information" means any non-public information disclosed by the Company '
        "to the Developer, whether orally, visually, in writing, electronically, or by access "
        "to systems, repositories, devices, or documentation, including without limitation:",
    )
    for item in [
        "source code, object code, repositories, build scripts, configuration files, and technical documentation;",
        "application architecture, APIs, backend integrations (including Supabase and third-party services), credentials, and environment variables;",
        "license management logic, business rules, and security mechanisms;",
        "design assets, branding, product roadmaps, and commercial information;",
        "customer, user, or business data made available for testing or migration;",
        "any information marked or reasonably understood as confidential.",
    ]:
        doc.add_paragraph(item, style="List Bullet")

    body(
        doc,
        "Confidential Information includes information disclosed before or after the Effective Date.",
    )

    heading(doc, "4. Developer Obligations", 2)
    for item in [
        "Use Confidential Information solely for the Purpose and not for any other purpose.",
        "Not disclose Confidential Information to any third party without the Company's prior written consent.",
        "Protect Confidential Information with at least the same degree of care the Developer uses for its own confidential information, and no less than reasonable care.",
        "Not subcontract or delegate any part of the work involving Confidential Information to any third party without the Company's prior written consent.",
        "Work only in repositories, tools, and environments controlled or expressly approved by the Company; not upload, mirror, fork, or store any part of the project in the Developer's personal or third-party accounts (including private GitHub, GitLab, cloud drives, or local backups) except temporarily and solely as required for the Purpose, and delete such copies when no longer needed.",
        "Not copy, reverse engineer, decompile, or attempt to derive source code or trade secrets except as strictly necessary for the Purpose and with the Company's prior written approval where required by law.",
        "Promptly notify the Company of any unauthorized use or disclosure of Confidential Information.",
        "Comply with applicable laws in Pakistan and internationally regarding export control, sanctions, and data protection, to the extent applicable to the Developer's performance.",
    ]:
        doc.add_paragraph(item, style="List Number")

    heading(doc, "5. Prohibition on Copying, Cloning, and Competing Products", 2)
    body(
        doc,
        "The Developer acknowledges that the Application, its source code, design, features, workflows, "
        "business logic, and related materials are proprietary to the Company. Without limiting the foregoing, "
        "the Developer expressly agrees that it shall NOT, during the term of this Agreement or thereafter "
        "(for the survival period stated in Section 7):",
    )
    for item in [
        "copy, reproduce, download, extract, or retain any portion of the Application, its source code, assets, documentation, or Confidential Information, except as strictly necessary to perform the Purpose for the Company;",
        "create, develop, publish, distribute, sublicense, sell, or otherwise make available any clone, fork, port, derivative work, or competing product that is based on, incorporates, or is substantially similar to the Application or any part thereof;",
        "reuse, adapt, or repurpose the Application's code, architecture, UI/UX, OCR flows, license system, Supabase integration, branding, or business rules for the Developer's own projects or for any third party;",
        "register, publish, or submit to Apple App Store, Google Play, or any other store or marketplace any application that reproduces or imitates the Application or its core functionality;",
        "share, leak, or transfer the project repository, credentials, build artifacts, or technical know-how to any person or entity other than the Company;",
        "take screenshots, screen recordings, or demos of the Application for portfolio, marketing, or public display without the Company's prior written consent.",
    ]:
        doc.add_paragraph(item, style="List Bullet")

    body(
        doc,
        "The Developer shall perform the iOS migration solely as work for hire / on behalf of the Company. "
        "The Developer acquires no ownership interest in the Application and no right to exploit it outside the Purpose.",
    )

    heading(doc, "6. Exclusions", 2)
    body(
        doc,
        "Confidential Information does not include information that the Developer can demonstrate:",
    )
    for item in [
        "is or becomes publicly available through no breach of this Agreement;",
        "was lawfully known to the Developer before disclosure by the Company;",
        "is lawfully received from a third party without breach of any confidentiality obligation;",
        "is independently developed by the Developer without use of or reference to the Company's Confidential Information.",
    ]:
        doc.add_paragraph(item, style="List Bullet")

    body(
        doc,
        "If the Developer is required by law, regulation, or court order to disclose Confidential Information, "
        "the Developer shall (to the extent legally permitted) provide prompt written notice to the Company "
        "and cooperate in seeking protective treatment.",
    )

    heading(doc, "7. Term and Survival", 2)
    body(
        doc,
        "This Agreement begins on the Effective Date and continues for three (3) years thereafter, "
        "unless terminated earlier by written notice. The Developer's obligations under Sections 4, 5, and 8 "
        "(confidentiality, non-copying, non-cloning, and intellectual property) survive termination for "
        "five (5) years from the date of last disclosure or last access to the project, "
        "or indefinitely with respect to trade secrets for as long as they remain trade secrets under applicable law.",
    )

    heading(doc, "8. Return and Destruction", 2)
    body(
        doc,
        "Upon the Company's written request, or upon completion or termination of the engagement, "
        "the Developer shall promptly return or permanently destroy all Confidential Information "
        "and certify destruction in writing (email is sufficient), except for one archival copy "
        "retained solely for legal compliance and subject to continuing confidentiality obligations.",
    )

    heading(doc, "9. Intellectual Property", 2)
    body(
        doc,
        "All Confidential Information and all intellectual property rights in the Application and related materials "
        "remain the exclusive property of the Company. No license or other rights are granted to the Developer "
        "except the limited right to use Confidential Information strictly for the Purpose.",
    )
    body(
        doc,
        "All work product, code, documentation, configurations, builds, and deliverables created by the Developer "
        "in connection with the iOS migration or the Application (including bug fixes, improvements, and App Store "
        "submission materials) are the exclusive property of the Company. To the extent any such work product "
        "does not vest automatically in the Company under applicable law, the Developer hereby irrevocably assigns "
        "to the Company all right, title, and interest therein upon creation. The Developer shall execute any "
        "further documents reasonably requested to perfect such assignment.",
    )
    body(
        doc,
        "The Developer retains no right to reuse, resell, republish, or create alternative versions of the "
        "Application or any part thereof, as set out in Section 5.",
    )

    heading(doc, "10. No Obligation; Independent Contractor", 2)
    body(
        doc,
        "Nothing in this Agreement obliges the Company to disclose any particular information, "
        "award any contract, or continue any business relationship. The Developer acts as an independent "
        "freelancer and contractor, not as an employee, agent, or partner of the Company. The Developer "
        "is solely responsible for its own taxes, social contributions, and legal compliance in Pakistan and elsewhere.",
    )

    heading(doc, "11. Data Protection", 2)
    body(
        doc,
        "If the Developer processes personal data on behalf of the Company, the parties shall comply with "
        "applicable data protection laws, including Regulation (EU) 2016/679 (GDPR). "
        "Additional data processing terms may be set out in a separate Data Processing Agreement if required.",
    )

    heading(doc, "12. Remedies", 2)
    body(
        doc,
        "The Developer acknowledges that unauthorized disclosure, copying, cloning, or competing use of the "
        "Application or Confidential Information may cause irreparable harm for which monetary damages may be "
        "inadequate. The Company shall be entitled to seek injunctive relief, withdrawal of competing applications "
        "from app stores, destruction of unauthorized copies, and any other remedies available at law or in equity, "
        "without prejudice to other rights.",
    )

    heading(doc, "13. Governing Law and Jurisdiction", 2)
    body(
        doc,
        "This Agreement is governed by the laws of Italy, without regard to conflict-of-law principles. "
        f"The parties submit to the exclusive jurisdiction of the courts of {COMPANY['jurisdiction']}, "
        "unless mandatory law provides otherwise.",
    )

    heading(doc, "14. General", 2)
    for item in [
        "Entire Agreement: This Agreement constitutes the entire agreement between the parties regarding confidentiality for the Purpose and supersedes prior oral or written understandings on that subject.",
        "Amendments: Amendments must be in writing and signed by both parties (scanned/PDF signatures and email confirmation are acceptable unless otherwise agreed).",
        "Assignment: The Developer may not assign this Agreement without the Company's prior written consent.",
        "Severability: If any provision is held invalid, the remaining provisions remain in effect.",
        "Language: This Agreement is drafted in English. In case of translation, the English version prevails unless otherwise agreed in writing.",
        "Counterparts: This Agreement may be executed in counterparts and by electronic signature, each of which shall be deemed an original.",
    ]:
        doc.add_paragraph(item, style="List Bullet")

    doc.add_paragraph()
    body(
        doc,
        "The Developer confirms having read and understood Section 5 (Prohibition on Copying, Cloning, "
        "and Competing Products) and agrees not to copy the project or create an independent or competing version.",
    )
    body(
        doc,
        "IN WITNESS WHEREOF, the parties have executed this Agreement as of the dates below.",
    )

    heading(doc, "15. Signatures", 2)

    doc.add_paragraph()
    p = doc.add_paragraph()
    p.add_run(f"DISCLOSING PARTY — {COMPANY['legal_name']}").bold = True
    filled_line(doc, "Name:", COMPANY["representative"])
    filled_line(doc, "Title / Role:", "Legal Representative")
    blank_line(doc, "Signature:", 54)
    blank_line(doc, "Date:", 58)

    doc.add_paragraph()
    p = doc.add_paragraph()
    p.add_run("RECEIVING PARTY — Developer (freelancer, Pakistan)").bold = True
    blank_line(doc, "Name:", 58)
    filled_line(doc, "Status:", "Independent freelancer")
    blank_line(doc, "Signature:", 54)
    blank_line(doc, "Date:", 58)

    doc.add_paragraph()
    note = doc.add_paragraph()
    note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    nr = note.add_run(
        "This document is a template for business use. The Company should obtain independent legal review "
        "before signing."
    )
    nr.italic = True
    nr.font.size = Pt(9)

    doc.save(OUT)
    print(f"Scritto: {OUT}")


if __name__ == "__main__":
    main()
