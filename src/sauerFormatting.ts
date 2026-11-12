const SAUER_COLOR_CLASSES: Readonly<Record<string, string>> = {
  "1": "sauer-color-blue",
  "3": "sauer-color-red",
  "7": "sauer-color-yellow",
};

export function sauerFormattedMarkup(value: string): string {
  const runs: Array<{ color?: string; text: string }> = [];
  const colorStack: Array<string | undefined> = [];
  let color: string | undefined;
  let text = "";

  const flush = (): void => {
    if (!text) return;
    runs.push({ color, text });
    text = "";
  };

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\f" || index + 1 >= value.length) {
      text += value[index];
      continue;
    }
    flush();
    const command = value[++index];
    if (command === "s") colorStack.push(color);
    else if (command === "r") color = colorStack.pop();
    else color = command;
  }
  flush();

  return runs.map((run) => {
    const escaped = escapeHtml(run.text);
    const className = run.color ? SAUER_COLOR_CLASSES[run.color] : undefined;
    return className ? `<span class="${className}">${escaped}</span>` : escaped;
  }).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  })[character] ?? character);
}
