import { describe, expect, it } from "vitest";
import { buildSmtpTransportOptions } from "./buildSmtpTransportOptions";

const baseConfig = {
  host: "smtp.example.com",
  port: 587,
  security: "STARTTLS" as const,
  username: "mailer",
  password: "secret",
};

describe("buildSmtpTransportOptions", () => {
  it("connects to the pinned address while validating TLS against the configured host", () => {
    const options = buildSmtpTransportOptions(baseConfig, "93.184.216.34");

    expect(options.host).toBe("93.184.216.34");
    expect(options.port).toBe(587);
    expect(options.tls).toEqual({
      servername: "smtp.example.com",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
  });

  it("uses implicit TLS for SSL", () => {
    const options = buildSmtpTransportOptions({ ...baseConfig, port: 465, security: "SSL" }, "93.184.216.34");

    expect(options).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
  });

  it("requires STARTTLS upgrade for STARTTLS", () => {
    const options = buildSmtpTransportOptions(baseConfig, "93.184.216.34");

    expect(options).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });

  it("disables TLS for NONE", () => {
    const options = buildSmtpTransportOptions({ ...baseConfig, port: 25, security: "NONE" }, "93.184.216.34");

    expect(options).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });

  it("sets timeouts and disables logging", () => {
    const options = buildSmtpTransportOptions(baseConfig, "93.184.216.34");

    expect(options).toMatchObject({
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      logger: false,
      debug: false,
    });
  });

  it("includes auth when username and password are present", () => {
    const options = buildSmtpTransportOptions(baseConfig, "93.184.216.34");

    expect(options.auth).toEqual({ user: "mailer", pass: "secret" });
  });

  it.each([
    { username: null, password: "secret" },
    { username: "mailer", password: null },
    { username: null, password: null },
    { username: "", password: "secret" },
  ])("omits auth when credentials are incomplete (%j)", (credentials) => {
    const options = buildSmtpTransportOptions({ ...baseConfig, ...credentials }, "93.184.216.34");

    expect(options).not.toHaveProperty("auth");
  });
});

describe("buildSmtpTransportOptions with an IP literal host", () => {
  it("omits tls.servername, which Node does not accept for IP addresses", () => {
    const options = buildSmtpTransportOptions(
      { host: "203.0.113.10", port: 587, security: "STARTTLS", username: null, password: null },
      "203.0.113.10"
    );
    expect(options.tls).toEqual({ rejectUnauthorized: true, minVersion: "TLSv1.2" });
  });
});
