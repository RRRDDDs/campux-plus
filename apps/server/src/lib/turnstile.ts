/**
 * Cloudflare Turnstile 服务端校验。
 * 站点在 Cloudflare 后面（橙云），Turnstile 是免费且对用户无感的人机验证。
 */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 8_000;

export type TurnstileVerifyResult = {
  ok: boolean;
  errorCodes: string[];
  /** 网络/超时等基础设施错误（此时应放行，不要因为 CF 抖动而挡住正常用户） */
  infrastructureFailure: boolean;
};

export async function verifyTurnstileToken(options: {
  secretKey: string;
  token: string;
  remoteIp?: string | undefined;
}): Promise<TurnstileVerifyResult> {
  const body = new URLSearchParams();
  body.set("secret", options.secretKey);
  body.set("response", options.token);
  if (options.remoteIp) {
    body.set("remoteip", options.remoteIp);
  }

  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => null)) as
      | { success?: boolean; "error-codes"?: string[] }
      | null;
    if (!response.ok || !data) {
      return { ok: false, errorCodes: [], infrastructureFailure: true };
    }
    return {
      ok: Boolean(data.success),
      errorCodes: Array.isArray(data["error-codes"]) ? data["error-codes"] : [],
      infrastructureFailure: false,
    };
  } catch {
    return { ok: false, errorCodes: [], infrastructureFailure: true };
  }
}
