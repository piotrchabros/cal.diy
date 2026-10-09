const FORBIDDEN_FILENAME_CHARACTERS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);
const FALLBACK_FILENAME = "transcript.md";

// A char-code check instead of a control-character regex keeps Biome's noControlCharactersInRegex quiet.
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

// The server already returns a safe name; this is the second line of defence for the `download` attribute.
export function sanitizeDownloadFilename(filename: string): string {
  const replaced = Array.from(filename, (char) => {
    if (FORBIDDEN_FILENAME_CHARACTERS.has(char) || isControlCharacter(char)) return "-";
    return char;
  }).join("");
  const withoutLeadingDots = replaced.replace(/^\.+/, "");
  if (withoutLeadingDots === "") return FALLBACK_FILENAME;
  return withoutLeadingDots;
}

export function downloadTextFile({
  filename,
  mimeType,
  content,
}: {
  filename: string;
  mimeType: string;
  content: string;
}): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeDownloadFilename(filename);
  anchor.click();

  URL.revokeObjectURL(url);
}
