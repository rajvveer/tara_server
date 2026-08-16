import { ApiError } from "./errors.js";
import { config } from "./config.js";

export async function sendPasswordResetEmail(to: string, token: string) {
  if (!config.RESEND_API_KEY) return false;
  const resetUrl = `${config.APP_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.RESET_FROM_EMAIL,
      to: [to],
      subject: "Reset your GoalSpring password",
      text: `Use this one-time reset code in GoalSpring:\n\n${token}\n\nOr open ${resetUrl}\n\nThis code expires in one hour.`,
      html: `<p>Use this one-time reset code in GoalSpring:</p><p><strong>${token}</strong></p><p><a href="${resetUrl}">Open password reset</a></p><p>This code expires in one hour.</p>`,
    }),
  });
  if (!response.ok) {
    throw new ApiError(503, "EMAIL_DELIVERY_FAILED", "Password reset email could not be sent. Please try again.");
  }
  return true;
}
