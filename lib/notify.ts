const OWNER_EMAIL = "business@alanany.com";
const FROM_EMAIL = "Scene Fixer <notifications@scenefixer.com>";

export async function notifyOwner(subject: string, text: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [OWNER_EMAIL], subject, text }),
    });
  } catch {
    // Non-critical
  }
}
