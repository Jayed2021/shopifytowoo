// server.js
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Configuration from environment variables
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const WC_URL = process.env.WC_URL; // e.g., https://yourstore.com
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

// Verify Shopify webhook signature
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  
  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(hmacHeader)
  );
}

// Webhook endpoint - use raw body parser for this route only
app.post('/webhook/shopify/order-create', 
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmac = req.get('X-Shopify-Hmac-Sha256');
      
      // Verify webhook authenticity
      if (!verifyShopifyWebhook(req.body, hmac)) {
        console.log('Invalid webhook signature');
        return res.status(401).send('Unauthorized');
      }

      const order = JSON.parse(req.body.toString());
      console.log(`Received Shopify order: #${order.order_number}`);

      // Transform Shopify order to WooCommerce format
      const wcOrder = await transformOrder(order);
      
      // Create order in WooCommerce
      const response = await axios.post(
        `${WC_URL}/wp-json/wc/v3/orders`,
        wcOrder,
        {
          auth: {
            username: WC_CONSUMER_KEY,
            password: WC_CONSUMER_SECRET
          }
        }
      );

      console.log(`WooCommerce order created: #${response.data.id}`);
      res.status(200).json({ 
        success: true, 
        wc_order_id: response.data.id 
      });

    } catch (error) {
      console.error('Error processing webhook:', error.response?.data || error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
);

// Transform Shopify order data to WooCommerce format
async function transformOrder(shopifyOrder) {
  // Map line items by SKU
  const lineItems = await Promise.all(
    shopifyOrder.line_items.map(async item => {
      // Try to find WooCommerce product by SKU
      const wcProduct = await findProductBySKU(item.sku);
      
      return {
        product_id: wcProduct?.id || 0,
        quantity: item.quantity,
        total: item.price,
        sku: item.sku,
        name: item.name
      };
    })
  );

  // Build WooCommerce order object
  return {
    status: 'processing',
    billing: {
      first_name: shopifyOrder.billing_address?.first_name || '',
      last_name: shopifyOrder.billing_address?.last_name || '',
      address_1: shopifyOrder.billing_address?.address1 || '',
      address_2: shopifyOrder.billing_address?.address2 || '',
      city: shopifyOrder.billing_address?.city || '',
      state: shopifyOrder.billing_address?.province_code || '',
      postcode: shopifyOrder.billing_address?.zip || '',
      country: shopifyOrder.billing_address?.country_code || '',
      email: shopifyOrder.email || '',
      phone: shopifyOrder.billing_address?.phone || ''
    },
    shipping: {
      first_name: shopifyOrder.shipping_address?.first_name || '',
      last_name: shopifyOrder.shipping_address?.last_name || '',
      address_1: shopifyOrder.shipping_address?.address1 || '',
      address_2: shopifyOrder.shipping_address?.address2 || '',
      city: shopifyOrder.shipping_address?.city || '',
      state: shopifyOrder.shipping_address?.province_code || '',
      postcode: shopifyOrder.shipping_address?.zip || '',
      country: shopifyOrder.shipping_address?.country_code || ''
    },
    line_items: lineItems,
    shipping_lines: shopifyOrder.shipping_lines?.map(line => ({
      method_title: line.title,
      total: line.price
    })) || [],
    customer_note: `Order synced from Shopify #${shopifyOrder.order_number}`,
    meta_data: [
      {
        key: '_shopify_order_id',
        value: shopifyOrder.id.toString()
      },
      {
        key: '_shopify_order_number',
        value: shopifyOrder.order_number.toString()
      }
    ]
  };
}

// Find WooCommerce product by SKU
async function findProductBySKU(sku) {
  if (!sku) return null;
  
  try {
    const response = await axios.get(
      `${WC_URL}/wp-json/wc/v3/products`,
      {
        params: { sku },
        auth: {
          username: WC_CONSUMER_KEY,
          password: WC_CONSUMER_SECRET
        }
      }
    );
    
    return response.data[0] || null;
  } catch (error) {
    console.error(`Error finding product with SKU ${sku}:`, error.message);
    return null;
  }
}

// Health check endpoint - needs JSON parser
app.get('/health', express.json(), (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
  console.log(`Environment check:`);
  console.log(`- WC_URL: ${WC_URL ? 'Set' : 'MISSING'}`);
  console.log(`- WC_CONSUMER_KEY: ${WC_CONSUMER_KEY ? 'Set' : 'MISSING'}`);
  console.log(`- WC_CONSUMER_SECRET: ${WC_CONSUMER_SECRET ? 'Set' : 'MISSING'}`);
  console.log(`- SHOPIFY_WEBHOOK_SECRET: ${SHOPIFY_WEBHOOK_SECRET ? 'Set' : 'MISSING'}`);
});
