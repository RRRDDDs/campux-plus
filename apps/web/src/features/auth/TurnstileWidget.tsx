import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile 人机验证控件。
 *
 * - siteKey 为空时什么都不渲染（未配置 Turnstile 的实例完全无感）；
 * - 显式渲染模式，token 通过回调交给父组件随表单一起提交；
 * - token 是一次性的：父组件在提交失败后更换 key 重新挂载即可重新取 token。
 */
type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_FLAG = "data-campux-turnstile";

export function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!siteKey) {
      return;
    }
    let disposed = false;

    const render = () => {
      if (disposed || !containerRef.current || !window.turnstile || widgetIdRef.current) {
        return;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: "auto",
        callback: (token: string) => onTokenRef.current(token),
        "expired-callback": () => onTokenRef.current(""),
        "error-callback": () => onTokenRef.current(""),
      });
    };

    if (window.turnstile) {
      render();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(`script[${SCRIPT_FLAG}]`);
      if (existing) {
        existing.addEventListener("load", render);
      } else {
        const script = document.createElement("script");
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.setAttribute(SCRIPT_FLAG, "1");
        script.addEventListener("load", render);
        document.head.appendChild(script);
      }
    }

    return () => {
      disposed = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // 控件已卸载时忽略
        }
      }
    };
  }, [siteKey]);

  if (!siteKey) {
    return null;
  }

  return (
    <div className="grid gap-1">
      <div ref={containerRef} className="min-h-[65px]" />
      <span className="text-xs text-slate-400">人机验证由 Cloudflare Turnstile 提供，通常无需手动操作。</span>
    </div>
  );
}
