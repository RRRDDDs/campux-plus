import { describe, expect, test } from "bun:test";
import { formatConfessionAccepted, formatConfessionMatch, parseConfessionArgs } from "./confession";

describe("parseConfessionArgs", () => {
  test("解析 QQ 号与正文", () => {
    expect(parseConfessionArgs("123456789 你笑起来真好看")).toEqual({
      targetQqUin: "123456789",
      text: "你笑起来真好看",
    });
  });

  test("兼容全角空格、中文冒号与逗号分隔", () => {
    expect(parseConfessionArgs("123456789　想认识你")).toEqual({ targetQqUin: "123456789", text: "想认识你" });
    expect(parseConfessionArgs("123456789：想认识你")).toEqual({ targetQqUin: "123456789", text: "想认识你" });
    expect(parseConfessionArgs("123456789，想认识你")).toEqual({ targetQqUin: "123456789", text: "想认识你" });
  });

  test("正文可以多行", () => {
    const parsed = parseConfessionArgs("123456789 第一行\n第二行");
    expect(parsed?.text).toBe("第一行\n第二行");
  });

  test("缺少正文或 QQ 号非法时返回 null", () => {
    expect(parseConfessionArgs("123456789")).toBeNull();
    expect(parseConfessionArgs("12345")).toBeNull();
    expect(parseConfessionArgs("1234567890123 太长")).toBeNull();
    expect(parseConfessionArgs("abc 你好")).toBeNull();
    expect(parseConfessionArgs("")).toBeNull();
  });
});

describe("表白文案", () => {
  test("未匹配时只提示已记下，并给出剩余次数", () => {
    const message = formatConfessionAccepted(2);
    expect(message).toContain("表白已经悄悄记下了");
    expect(message).toContain("对方不会收到任何提示");
    expect(message).toContain("今天还可以表白 2 次");
  });

  test("次数用尽时不展示剩余次数", () => {
    expect(formatConfessionAccepted(0)).not.toContain("今天还可以表白");
  });

  test("互相表白时告知双方身份与彼此原话", () => {
    const message = formatConfessionMatch({
      partnerQqUin: "123456789",
      partnerDisplayName: "小明",
      myText: "我喜欢你",
      partnerText: "我也是",
    });
    expect(message).toContain("青青子衿，悠悠我心");
    expect(message).toContain("小明（123456789）");
    expect(message).toContain("TA 对你说：我也是");
    expect(message).toContain("你对 TA 说：我喜欢你");
  });

  test("对方没有昵称时只用 QQ 号", () => {
    const message = formatConfessionMatch({
      partnerQqUin: "123456789",
      partnerDisplayName: null,
      myText: "a",
      partnerText: "b",
    });
    expect(message).toContain("你和 123456789 互相表白了！");
  });
});
