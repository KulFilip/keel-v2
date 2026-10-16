// keel 0.18.9 what KeelBot gets when the person asks it to fix something that failed (the dashboard's "Ask KeelBot to
// fix it", keel TUI's /fix and its question after a failed button): what was tried, keel's error and hint, and the job.
export function fixRequest(what: string, error: { message: string; hint?: string }): string {
  return `This failed: ${what}.\nkeel said: ${error.message}${error.hint ? `\nkeel's hint: ${error.hint}` : ""}\n`
    + "Find the cause in this project (look at its state: git status, the files, the flow), explain it in one or two plain "
    + "sentences, and propose how to fix it, with the buttons that do it. Change nothing yourself.";
}
