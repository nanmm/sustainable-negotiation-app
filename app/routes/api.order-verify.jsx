// @ts-nocheck
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const orderNumber = url.searchParams.get("order_number")?.trim();
  const email = url.searchParams.get("email")?.trim();
  const debugFlag =
    url.searchParams.get("dbg") ??
    url.searchParams.get("debug") ??
    url.searchParams.get("_debug") ??
    "";
  const debug =
    url.searchParams.has("dbg") ||
    url.searchParams.has("debug") ||
    url.searchParams.has("_debug") ||
    debugFlag === "1" ||
    debugFlag.toLowerCase() === "true";

  if (!orderNumber || !email) {
    return Response.json(
      debug
        ? {
            exists: false,
            debug: {
              reason: "missing_params",
              dbg: url.searchParams.get("dbg"),
              debug: url.searchParams.get("debug"),
              _debug: url.searchParams.get("_debug"),
              keys: Array.from(url.searchParams.keys()),
            },
          }
        : { exists: false },
      {
        status: 400,
        headers: { "Content-Type": "application/json", "X-Dbg-Seen": debugFlag || "" },
      }
    );
  }

  // 规范化订单号：去空格，补 #
  let orderName = orderNumber.replace(/\s/g, "");
  if (!orderName.startsWith("#")) {
    orderName = "#" + orderName;
  }

  try {
    let admin;
    try {
      ({ admin } = await authenticate.public.appProxy(request));
    } catch (proxyErr) {
      console.error("order-verify appProxy:", proxyErr);
      return Response.json(
        debug
          ? {
              exists: false,
              debug: {
                reason: "app_proxy_auth_failed",
                message: String(proxyErr?.message ?? proxyErr),
              },
            }
          : { exists: false },
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (!admin) {
      let sessionCount = null;
      let sampleShops = null;
      try {
        sessionCount = await db.session.count();
        const sessions = await db.session.findMany({
          select: { shop: true },
          take: 5,
          orderBy: { shop: "asc" },
        });
        sampleShops = sessions.map((s) => s.shop);
      } catch {
        // ignore db errors in debug response
      }
      return Response.json(
        debug
          ? {
              exists: false,
              debug: {
                reason: "no_admin_in_app_proxy_context",
                shop: url.searchParams.get("shop"),
                keys: Array.from(url.searchParams.keys()),
                sessionCount,
                sampleShops,
              },
            }
          : { exists: false },
        { headers: { "Content-Type": "application/json" } }
      );
    }
    
    const base = orderName.replace(/^#/, "").split("-")[0]; // 1001-F1 -> 1001
    // Match Shopify Admin order search behavior: "1001" works, and add email filter to reduce false positives.
    // Use a unique variable name to avoid TS language-service false "redeclare" errors.
    const orderQuery = `${base} email:${email}`;
    let data;
    try {
      const response = await admin.graphql(
        `#graphql
      query getOrders($query: String!) {
        orders(first: 20, query: $query) {
          edges {
            node {
              id
              name
              email
              customer {
                email
              }
            }
          }
        }
      }`,
        {
          variables: {
            query: orderQuery,
          },
        }
      );

      data = await response.json();
    } catch (gqlErr) {
      console.error("order-verify graphql:", gqlErr);
      return Response.json(
        debug
          ? {
              exists: false,
              debug: {
                reason: "graphql_request_failed",
                message: String(gqlErr?.message ?? gqlErr),
                orderQuery,
              },
            }
          : { exists: false },
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const edges = data?.data?.orders?.edges ?? [];
    const normalizedInput = email.toLowerCase();

    const matched = edges.find(({ node }) => {
      const name = (node?.name || "").replace(/^#/, "");
      const orderMain = name.split("-")[0];
      const emailCandidates = [node?.email, node?.customer?.email]
        .filter(Boolean)
        .map((value) => value.toLowerCase());

      return orderMain === base && emailCandidates.includes(normalizedInput);
    });

    if (debug) {
      return Response.json(
        {
          exists: !!matched,
          debug: {
            orderNumber,
            orderQuery,
            edgesLen: edges.length,
            first: edges[0]?.node ?? null,
            errors: data?.errors ?? null,
            dbg: url.searchParams.get("dbg"),
            debug: url.searchParams.get("debug"),
            _debug: url.searchParams.get("_debug"),
            keys: Array.from(url.searchParams.keys()),
          },
        },
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return Response.json({ exists: !!matched }, { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("order-verify fatal:", e);
    // App Proxy: avoid 5xx so the storefront does not show Shopify's generic third-party error page.
    return Response.json(
      debug
        ? {
            exists: false,
            debug: {
              reason: "fatal",
              error: String(e?.message ?? e),
            },
          }
        : { exists: false },
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
};