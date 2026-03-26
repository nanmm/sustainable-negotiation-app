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

    const response = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              email
            }
          }
        }
      }`,
      {
        variables: {
          query: `name:${orderName}`,
        },
      }
    );

    const data = await response.json();
    const edges = data?.data?.orders?.edges ?? [];
    const order = edges[0]?.node;

    const emailMatch =
      order?.email &&
      order.email.toLowerCase() === email.toLowerCase();

    return Response.json(
      { exists: !!emailMatch },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Order verify error:", e);
    return Response.json(
      { exists: false },
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};