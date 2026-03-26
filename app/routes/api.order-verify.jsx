import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const orderNumber = url.searchParams.get("order_number")?.trim();
  const email = url.searchParams.get("email")?.trim();

  if (!orderNumber || !email) {
    return Response.json({ exists: false }, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 规范化订单号：去空格，补 #
  let orderName = orderNumber.replace(/\s/g, "");
  if (!orderName.startsWith("#")) {
    orderName = "#" + orderName;
  }

  try {
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
      return Response.json({ exists: false }, {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    const base = orderName.replace(/^#/, "").split("-")[0]; // 1001-F1 -> 1001
    const keyword = `#${base}`;
    const response = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              email
              displayFinancialStatus
              customer {
                email
              }
            }
          }
        }
      }`,
      {
        variables: {
          query: keyword,
        },
      }
    );

    const data = await response.json();
    console.log("verify debug", {
      query: keyword,
      edgesLen: data?.data?.orders?.edges?.length,
      first: data?.data?.orders?.edges?.[0]?.node,
      inputEmail: email,
    });
    const edges = data?.data?.orders?.edges ?? [];
    const order = edges[0]?.node;
    
    return Response.json(
      {
        exists: false,
        debug: {
          query: keyword,
          edgesLen: edges.length,
          first: order,
          inputEmail: email,
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return Response.json(
      { exists: false, debug: { error: String(e) } },
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};