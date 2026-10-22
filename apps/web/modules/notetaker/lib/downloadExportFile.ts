import type { NotetakerExportDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { downloadBlob, downloadTextFile } from "@calcom/web/modules/notetaker/lib/downloadTextFile";

function decodeBase64(content: string): Uint8Array<ArrayBuffer> {
  const binary = atob(content);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function downloadExportFile(file: NotetakerExportDto): void {
  if (file.encoding === "utf8") {
    downloadTextFile(file);
    return;
  }
  downloadBlob({
    filename: file.filename,
    blob: new Blob([decodeBase64(file.content)], { type: file.mimeType }),
  });
}
