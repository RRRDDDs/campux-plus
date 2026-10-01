import { describe, expect, test } from "bun:test";
import { normalizeApplicationStatus, toTenantApplicationSummary } from "./tenant-application";

describe("开墙申请状态处理", () => {
  test("已知状态原样返回", () => {
    expect(normalizeApplicationStatus("pending")).toBe("pending");
    expect(normalizeApplicationStatus("approved")).toBe("approved");
    expect(normalizeApplicationStatus("rejected")).toBe("rejected");
  });

  test("未知或空值按待审核处理（避免脏数据放开权限）", () => {
    expect(normalizeApplicationStatus("weird")).toBe("pending");
    expect(normalizeApplicationStatus(null)).toBe("pending");
    expect(normalizeApplicationStatus(undefined)).toBe("pending");
  });

  test("转换为前端摘要时保留墙名、备注与时间", () => {
    const summary = toTenantApplicationSummary({
      id: "app-1",
      wallName: "XX中学万能墙",
      school: "XX中学",
      contact: "QQ 123456",
      reason: "想给同学一个树洞",
      status: "approved",
      reviewNote: "同意",
      reviewedAt: new Date("2026-10-01T02:00:00.000Z"),
      createdAt: new Date("2026-10-01T01:00:00.000Z"),
    });

    expect(summary.status).toBe("approved");
    expect(summary.wallName).toBe("XX中学万能墙");
    expect(summary.reviewNote).toBe("同意");
    expect(summary.reviewedAt).toBe("2026-10-01T02:00:00.000Z");
    expect(summary.createdAt).toBe("2026-10-01T01:00:00.000Z");
  });

  test("未处理时 reviewedAt 为空", () => {
    const summary = toTenantApplicationSummary({
      id: "app-2",
      wallName: "测试墙",
      school: null,
      contact: null,
      reason: null,
      status: "unknown",
      reviewNote: null,
      reviewedAt: null,
      createdAt: new Date("2026-10-01T01:00:00.000Z"),
    });
    expect(summary.status).toBe("pending");
    expect(summary.reviewedAt).toBeNull();
    expect(summary.school).toBeNull();
  });
});
