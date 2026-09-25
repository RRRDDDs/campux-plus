import { describe, expect, test } from "bun:test";
import { parseConfessionArgs, parseConfessionCommandText } from "./confession";

/**
 * 机器人私聊命令的解析链路：#表白 <QQ号> <正文>。
 * 这里直接复用运行时的命令解析器，确保「表白」能被当成命令名解析出来，
 * 且参数能继续被表白解析器正确处理（避免出现「命令被当正文吞掉」的情况）。
 */
describe("机器人表白命令解析", () => {
  test("支持半角 # 前缀", () => {
    const args = parseConfessionCommandText("#表白 123456789 你笑起来真好看");
    expect(args).not.toBeNull();
    expect(parseConfessionArgs(args ?? "")).toEqual({
      targetQqUin: "123456789",
      text: "你笑起来真好看",
    });
  });

  test("支持全角 ＃ 前缀与中文冒号（中文输入法常见）", () => {
    const args = parseConfessionCommandText("＃表白：123456789 想认识你");
    expect(args).toBe("123456789 想认识你");
    expect(parseConfessionArgs(args ?? "")?.targetQqUin).toBe("123456789");
  });

  test("支持 @机器人 前缀写法", () => {
    const args = parseConfessionCommandText("@墙号 #表白 123456789 你好");
    expect(parseConfessionArgs(args ?? "")?.text).toBe("你好");
  });

  test("缺少参数时返回空参数（由处理器提示格式）", () => {
    expect(parseConfessionCommandText("#表白")).toBe("");
    expect(parseConfessionArgs("")).toBeNull();
  });

  test("普通投稿文本不会被误认成表白命令", () => {
    expect(parseConfessionCommandText("今天想表白一下可以吗")).toBeNull();
    expect(parseConfessionCommandText("#投稿 我想表白一个人")).toBeNull();
    expect(parseConfessionCommandText("#帮助")).toBeNull();
  });
});
