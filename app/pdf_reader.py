import fitz


def extract_pages(pdf_path: str) -> list[str]:
    """Extract text from each page. Returns list of page texts."""
    pages = []
    with fitz.open(pdf_path) as doc:
        for page in doc:
            text = page.get_text().strip()
            pages.append(text if text else "[This page has no readable text]")
    return pages


def extract_page(pdf_path: str, page: int) -> str:
    """Extract text from one page (0-based)."""
    with fitz.open(pdf_path) as doc:
        text = doc[page].get_text().strip()
    return text if text else "[This page has no readable text]"


def get_page_count(pdf_path: str) -> int:
    with fitz.open(pdf_path) as doc:
        return len(doc)


def get_book_info(pdf_path: str) -> dict:
    with fitz.open(pdf_path) as doc:
        meta = doc.metadata
        return {
            "title" : meta.get("title")  or "Unknown Title",
            "author": meta.get("author") or "Unknown Author",
            "pages" : len(doc),
        }


def extract_toc(pdf_path: str) -> list[dict]:
    """
    Extract table of contents from PDF.
    Returns list of chapters with title and page number.
    Falls back to page-number list if no TOC exists.
    """
    with fitz.open(pdf_path) as doc:
        toc = doc.get_toc()  # Returns [[level, title, page], ...]

        if toc:
            chapters = []
            for level, title, page in toc:
                if level <= 2:  # Only top 2 heading levels
                    chapters.append({
                        "title": title.strip(),
                        "page" : max(0, page - 1),  # Convert to 0-based
                        "level": level,
                    })
            return chapters

        # No TOC — return every 10th page as a navigation point
        total = len(doc)
        return [
            {"title": f"Page {i + 1}", "page": i, "level": 1}
            for i in range(0, total, 10)
        ]