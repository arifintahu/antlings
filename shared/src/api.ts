import { z } from 'zod';

/** Loose shape of a WebAuthn JSON response. The server library validates the contents. */
export const WebAuthnJson = z.record(z.string(), z.unknown());

export const SetupCode = z.string().min(4).max(32);
export const Password = z.string().min(12).max(256);
export const TotpCode = z.string().regex(/^\d{6}$/);

export const SetupOptionsBody = z.object({
  code: SetupCode,
  name: z.string().trim().min(1).max(64).optional(),
});
export const SetupVerifyBody = z.object({
  code: SetupCode,
  name: z.string().trim().min(1).max(64).optional(),
  response: WebAuthnJson,
});
export const PasskeyLoginVerifyBody = z.object({
  challengeId: z.string().min(8).max(128),
  response: WebAuthnJson,
});
export const PasswordLoginBody = z.object({ password: z.string().min(1).max(256) });
export const TotpLoginBody = z.object({ pendingId: z.string().min(8).max(128), code: TotpCode });
export const StepUpTotpBody = z.object({ code: TotpCode });
export const StepUpPasskeyVerifyBody = PasskeyLoginVerifyBody;
export const AddPasskeyVerifyBody = z.object({
  challengeId: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(64).optional(),
  response: WebAuthnJson,
});
export const FallbackSetBody = z.object({ password: Password });
export const FallbackConfirmBody = z.object({ code: TotpCode });
export const SettingsBody = z.object({
  idleTimeoutHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  signinAlerts: z.boolean().optional(),
});
export const SignOutDeviceBody = z.object({ id: z.string().min(8).max(64) });

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
