/** Secret-shaped things that must never reach the model (F12, HowToVerify M6). Returns what leaked. */
export function leaks(text: string, secrets: string[]): string[] {
  const found = secrets.filter((s) => s && text.includes(s));
  for (const re of [/eyJ[A-Za-z0-9_-]{5,}\./, /ses_[A-Za-z0-9_-]{8,}/, /code=/, /"d":/]) if (re.test(text)) found.push(re.source);
  return found;
}
