const composer = "[data-app-composer]:has([data-focused-diff-replacement])";
const toggle = "[id='thread-prompt-banner-git-toggle']";
const body = "[id='thread-prompt-banner-git-body']";
const compactHidden = "[data-promptbox-hide-compact]";
const control = ":is(a, button, [role='button'])";

function hideShell(ignored: string) {
  const row = `${control}:not(${toggle})${ignored}`;
  const later = `${control}:not(${body} *)${ignored}`;
  return `${composer} section[aria-label='Thread context before sending']:has(> :first-child ${toggle}):not(:has(> :first-child ${row})):not(:has(> :nth-child(n+2) ${later})) { display: none !important; }`;
}

export const nativeTrackerCss = `
${composer} ${toggle}, ${composer} ${body} { display: none !important; }
${hideShell("")}
@container promptbox (width<=30rem) {
${hideShell(`:not(${compactHidden} *)`)}
}
@container promptbox-shell (width<=34rem) {
${hideShell(`:not(${compactHidden} *)`)}
}
`;

export function mountNativeTracker() {
  const style = document.createElement("style");
  style.dataset.focusedDiffNative = "";
  style.textContent = nativeTrackerCss;
  document.head.append(style);
  return () => style.remove();
}
