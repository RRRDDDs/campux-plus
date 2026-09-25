import { describe, expect, test } from "bun:test";
import { DEFAULT_POST_REVIEW_RULES } from "@campux/domain";
import { parsePostReviewVerdict } from "./ai-review";

describe("parsePostReviewVerdict", () => {
  test("解析标准 JSON 输出", () => {
    const verdict = parsePostReviewVerdict(JSON.stringify({
      riskLevel: "low",
      suggestedAction: "approve",
      confidence: 0.93,
      categories: ["表白"],
      reasons: ["符合墙规"],
      sensitiveFindings: [],
      rejectionReason: null,
    }));

    expect(verdict?.riskLevel).toBe("low");
    expect(verdict?.suggestedAction).toBe("approve");
    expect(verdict?.confidence).toBe(0.93);
    expect(verdict?.categories).toEqual(["表白"]);
    expect(verdict?.rejectionReason).toBeNull();
  });

  test("容忍 Markdown 代码块与前后废话", () => {
    const verdict = parsePostReviewVerdict(
      "好的，结果如下：\n```json\n{\"riskLevel\":\"high\",\"suggestedAction\":\"reject\",\"confidence\":0.97,\"reasons\":[\"涉政\"],\"rejectionReason\":\"涉及政治敏感内容\"}\n```\n",
    );

    expect(verdict?.suggestedAction).toBe("reject");
    expect(verdict?.riskLevel).toBe("high");
    expect(verdict?.rejectionReason).toBe("涉及政治敏感内容");
  });

  test("字段缺失或非法时按中风险转人工", () => {
    const verdict = parsePostReviewVerdict("{\"foo\":1}");
    expect(verdict?.suggestedAction).toBe("manual_review");
    expect(verdict?.riskLevel).toBe("medium");
    expect(verdict?.confidence).toBe(0.5);
  });

  test("置信度会被裁剪到 0-1", () => {
    expect(parsePostReviewVerdict("{\"confidence\":9}")?.confidence).toBe(1);
    expect(parsePostReviewVerdict("{\"confidence\":-3}")?.confidence).toBe(0);
  });

  test("无法解析时返回 null，由调用方保持待审", () => {
    expect(parsePostReviewVerdict("模型今天不想干活")).toBeNull();
    expect(parsePostReviewVerdict("")).toBeNull();
  });

  test("内置墙规包含宽松口径与拒绝项", () => {
    expect(DEFAULT_POST_REVIEW_RULES).toContain("吐槽老师和学校管理是允许的");
    expect(DEFAULT_POST_REVIEW_RULES).toContain("政治敏感");
    expect(DEFAULT_POST_REVIEW_RULES).toContain("恶意攻击");
  });
});
