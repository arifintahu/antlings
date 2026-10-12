import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

export interface StoredPasskey {
  id: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
}

export type RegisteredPasskey = StoredPasskey;

/** The seam between the auth service and the WebAuthn library. Tests replace it with a fake. */
export interface WebAuthnService {
  registrationOptions(
    existingIds: string[],
    userName: string,
  ): Promise<{ options: unknown; challenge: string }>;
  verifyRegistration(response: unknown, challenge: string): Promise<RegisteredPasskey | null>;
  authOptions(): Promise<{ options: unknown; challenge: string }>;
  verifyAuth(
    response: unknown,
    challenge: string,
    lookup: (id: string) => StoredPasskey | undefined,
  ): Promise<{ id: string; newCounter: number } | null>;
}

const USER_ID = new TextEncoder().encode('antlings-owner');

export function realWebAuthn(rpId: string, origin: string): WebAuthnService {
  return {
    async registrationOptions(existingIds, userName) {
      const options = await generateRegistrationOptions({
        rpName: 'Antlings',
        rpID: rpId,
        userName,
        userID: USER_ID,
        attestationType: 'none',
        excludeCredentials: existingIds.map((id) => ({ id })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      });
      return { options, challenge: options.challenge };
    },
    async verifyRegistration(response, challenge) {
      try {
        const v = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
          requireUserVerification: false,
        });
        if (!v.verified) return null;
        const c = v.registrationInfo.credential;
        return {
          id: c.id,
          publicKey: Buffer.from(c.publicKey),
          counter: c.counter,
          transports: (c.transports ?? []) as string[],
        };
      } catch {
        return null;
      }
    },
    async authOptions() {
      const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'preferred' });
      return { options, challenge: options.challenge };
    },
    async verifyAuth(response, challenge, lookup) {
      try {
        const r = response as AuthenticationResponseJSON;
        const stored = lookup(r.id);
        if (!stored) return null;
        const credential: WebAuthnCredential = {
          id: stored.id,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports as WebAuthnCredential['transports'],
        };
        const v = await verifyAuthenticationResponse({
          response: r,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
          credential,
          requireUserVerification: false,
        });
        return v.verified ? { id: stored.id, newCounter: v.authenticationInfo.newCounter } : null;
      } catch {
        return null;
      }
    },
  };
}
