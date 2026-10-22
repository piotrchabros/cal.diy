const PRINT_CLEANUP_TIMEOUT_MS = 60_000;

// The sandbox omits allow-scripts so the exported document cannot run script while the user's origin is shared for printing.
export function printHtmlDocument(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  iframe.style.position = "fixed";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.srcdoc = html;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    iframe.remove();
  };

  iframe.addEventListener("load", () => {
    const printWindow = iframe.contentWindow;
    if (!printWindow) return;
    printWindow.addEventListener("afterprint", cleanup);
    printWindow.print();
  });

  // afterprint is not fired by every browser, so the iframe would otherwise stay in the page.
  timeoutId = setTimeout(cleanup, PRINT_CLEANUP_TIMEOUT_MS);
  document.body.appendChild(iframe);
}
