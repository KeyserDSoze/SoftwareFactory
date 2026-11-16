/** Approved fixed issuers of the disposable OIDC provider.
 * Runs only with an ephemeral control key in an internal CI Docker network.
 */
export function oidcCiTransport(env) {
  if (env.CI !== "true" || typeof env.OIDC_CI_SECRET !== "string" ||
      env.OIDC_CI_SECRET.length < 32)
    throw Error("CI-only OIDC transport requires ephemeral control secret");
  if (env.OIDC_ISSUER === "http://identity:8999")
    return { secure: false, port: 8999 };
  if (env.OIDC_ISSUER === "https://identity-tls:9443")
    return { secure: true, port: 9443,
      cert: "/ci-tls/server.crt", key: "/ci-tls/server.key" };
  throw Error("CI-only OIDC issuer must use an approved private Docker alias and port");
}
