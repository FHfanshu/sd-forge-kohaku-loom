export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const authStatus = message.match(/(?<!\d)(401|403)(?!\d)/)?.[1];
  if (authStatus) {
    return `Provider rejected the configured credentials (HTTP ${authStatus}). Update the API key in Model profiles and try again.`;
  }
  return message;
}
