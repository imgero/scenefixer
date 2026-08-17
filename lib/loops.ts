export async function registerLoopsContact(email: string, userId: string) {
  try {
    await fetch("/api/loops/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, userId }),
    });
  } catch {
    // Non-critical — don't surface to user
  }
}
