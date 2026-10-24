export const help = `book-memory chunk FILE [options]

Parse a document with officeparser and print JSON chunks to stdout.
Supports Markdown, PDF, DOCX, PPTX, XLSX and other officeparser formats.

Options:
  --strategy NAME        document-structure (default) or fixed-size
  --chunk-size NUMBER    Size in UTF-16 code units (default: 1000)
  --overlap NUMBER       fixed-size only (default: min(200, size / 5))
  --split-by NAME        Structure only: paragraph (default), heading, page, slide, sheet
  --table-split NAME     Structure only: row (default) or flatten
  --help                Show this help

Indices refer to extracted text, not original file offsets. OCR is disabled.
`;

export function helpMessage() {
  console.log(help);
  return;
}
