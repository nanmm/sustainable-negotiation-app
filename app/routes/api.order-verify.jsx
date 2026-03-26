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
          query: keyword,
        },
      }
    );

    const data = await response.json();
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

    return Response.json(
      { exists: !!matched },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return Response.json(
      { exists: false },
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};