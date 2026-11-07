import { describe, expect, it, vi } from "vitest";

vi.mock("@calcom/lib/constants", () => ({
  WEBSITE_URL: "https://cal.example.com",
}));

import { createPaymentLink } from "./createPaymentLink";

describe("createPaymentLink", () => {
  it("prefixes the link with WEBSITE_URL by default", () => {
    expect(createPaymentLink({ paymentUid: "pay_1", name: "Ann" })).toBe(
      "https://cal.example.com/payment/pay_1?date=&name=Ann&email="
    );
  });

  it("prefixes the link with baseUrl when provided", () => {
    expect(createPaymentLink({ paymentUid: "pay_1", baseUrl: "https://acme.example.com" })).toBe(
      "https://acme.example.com/payment/pay_1?date=&name=&email="
    );
  });

  it("falls back to WEBSITE_URL when baseUrl is null or empty", () => {
    expect(createPaymentLink({ paymentUid: "pay_1", baseUrl: null })).toMatch(
      /^https:\/\/cal\.example\.com\/payment\/pay_1\?/
    );
    expect(createPaymentLink({ paymentUid: "pay_1", baseUrl: "" })).toMatch(
      /^https:\/\/cal\.example\.com\/payment\/pay_1\?/
    );
  });

  it("returns a relative link when absolute is false, ignoring baseUrl", () => {
    expect(
      createPaymentLink({ paymentUid: "pay_1", absolute: false, baseUrl: "https://acme.example.com" })
    ).toBe("/payment/pay_1?date=&name=&email=");
  });
});
