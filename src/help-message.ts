export const help = `book-memory chunk FILE [options]

Parse a document with officeparser and print JSON chunks to stdout.
Supports Markdown, PDF, DOCX, PPTX, XLSX and other officeparser formats.

Options:
  --chunk-size NUMBER    Size in UTF-16 code units (default: 2000)
  --help                Show this help

Indices refer to extracted text, not original file offsets. OCR is disabled.
`;

export function helpMessage() {
  console.log(help);
  return;
}
