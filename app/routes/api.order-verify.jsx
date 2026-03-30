// @ts-nocheck
import { authenticate } from "../shopify.server";
import db from "../db.server";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Theme Section Rendering may hit this URL with ?section_id=... and expect HTML, not JSON.
 * Returning application/json on those subrequests often shows as Shopify's third‑party app error.
 */
function orderVerifyResponse(url, body, status = 200, extraHeaders = {}) {
  const sectionId = url.searchParams.get("section_id");
  if (sectionId) {
    const json = JSON.stringify(body);
    const html = `<div class="shopify-section order-verify-app-proxy" data-section-id="${escapeHtml(sectionId)}"><pre class="order-verify-json">${escapeHtml(json)}</pre></div>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders,
      },
    });
  }
  return Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

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
    return orderVerifyResponse(
      url,
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
      400,
      { "X-Dbg-Seen": debugFlag || "" },
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
      const message =
        proxyErr instanceof Response
          ? `upstream_response_${proxyErr.status}`
          : String(proxyErr?.message ?? proxyErr);
      return orderVerifyResponse(
        url,
        debug
          ? {
              exists: false,
              debug: {
                reason: "app_proxy_auth_failed",
                message,
              },
            }
          : { exists: false },
        200,
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
      return orderVerifyResponse(
        url,
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
        200,
      );
    }

    const base = orderName.replace(/^#/, "").split("-")[0]; // 1001-F1 -> 1001
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
        },
      );

      data = await response.json();
    } catch (gqlErr) {
      console.error("order-verify graphql:", gqlErr);
      return orderVerifyResponse(
        url,
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
        200,
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
      return orderVerifyResponse(url, {
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
      });
    }

    return orderVerifyResponse(url, { exists: !!matched });
  } catch (e) {
    console.error("order-verify fatal:", e);
    return orderVerifyResponse(
      url,
      debug
        ? {
            exists: false,
            debug: {
              reason: "fatal",
              error: String(e?.message ?? e),
            },
          }
        : { exists: false },
      200,
    );
  }
};
