// Bihari Dhaba AI Assistant — Netlify Function version.
// Same logic as chatbot-backend/server.js, adapted to Netlify's
// handler(event) format instead of an always-on Express server.
// GEMINI_API_KEY is read from Netlify's own environment variables
// (Site settings → Environment variables) — never from code.

const { GoogleGenAI } = require('@google/genai');
const DATA = require('./menu-data.json');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.6-flash';
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const SERVER_FUNCS = ['search_menu', 'get_product_details', 'get_restaurant_info', 'get_current_offers', 'get_location', 'get_cart'];
const CLIENT_FUNCS = ['add_to_cart', 'remove_from_cart', 'update_cart_quantity', 'guide_to_booking'];

const TOOLS = [{
  functionDeclarations: [
    { name: 'search_menu', description: 'Search the real menu by keyword, category, max price, or veg-only.', parameters: { type: 'object', properties: {
      query: { type: 'string' }, category: { type: 'string' }, max_price: { type: 'number' }, veg_only: { type: 'boolean' } } } },
    { name: 'get_product_details', description: 'Get full details of one menu item by id.', parameters: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } },
    { name: 'get_restaurant_info', description: 'Get address, phone, hours, delivery/pickup availability.', parameters: { type: 'object', properties: {} } },
    { name: 'get_current_offers', description: 'Get real current combo/offer deals.', parameters: { type: 'object', properties: {} } },
    { name: 'get_location', description: 'Get address and Google Maps directions link.', parameters: { type: 'object', properties: {} } },
    { name: 'get_cart', description: "Get the customer's current real cart contents.", parameters: { type: 'object', properties: {} } },
    { name: 'add_to_cart', description: 'Add a real item to the cart.', parameters: { type: 'object', properties: { item_id: { type: 'string' }, name_or_id: { type: 'string' }, quantity: { type: 'integer' } } } },
    { name: 'remove_from_cart', description: 'Remove an item from the cart.', parameters: { type: 'object', properties: { item_id: { type: 'string' }, name_or_id: { type: 'string' } } } },
    { name: 'update_cart_quantity', description: 'Set an item to an exact quantity in the cart.', parameters: { type: 'object', properties: { item_id: { type: 'string' }, name_or_id: { type: 'string' }, quantity: { type: 'integer' } }, required: ['quantity'] } },
    { name: 'guide_to_booking', description: 'No live booking backend exists — this only scrolls the customer to the Book a Table form. Never claim a booking is confirmed.', parameters: { type: 'object', properties: { date: { type: 'string' }, time: { type: 'string' }, guests: { type: 'integer' } } } },
  ],
}];

function systemPrompt() {
  return `You are the "Bihari Dhaba AI Assistant". Detect the customer's language/script (Hindi, Hinglish, English, or any other supported language) and reply in that same language. Keep replies short and warm (2-4 sentences).

Never invent restaurant facts (price, availability, hours, discounts, ingredients, booking confirmation, order status, address) — always call a function to get real data first. If something genuinely isn't available even via functions, say: "I don't have confirmed information about that right now," and suggest calling the restaurant or checking the menu.

Remember earlier turns (budget, spice preference, which dish "isme"/"it" refers to) and don't re-ask for info already given.

There is no live table-booking or order-tracking backend: for booking, use guide_to_booking and tell the customer to confirm date/time/guests in the form that opens — never say a table is confirmed. For order status, say you don't have that information and suggest contacting the restaurant.

For general non-restaurant questions, answer normally and briefly; don't force restaurant promotion into every reply.`;
}

function executeServerFunction(name, args, cart, productIds) {
  args = args || {};
  if (name === 'search_menu') {
    const items = DATA.menu.filter(it => {
      if (args.category && it.category.toLowerCase() !== String(args.category).toLowerCase()) return false;
      if (typeof args.max_price === 'number' && it.price > args.max_price) return false;
      if (args.veg_only && !it.veg) return false;
      if (args.query) {
        const q = String(args.query).toLowerCase();
        if (!(it.name.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q) || it.category.toLowerCase().includes(q))) return false;
      }
      return true;
    }).slice(0, 6);
    items.forEach(i => productIds.push(i.id));
    return { count: items.length, items };
  }
  if (name === 'get_product_details') {
    const it = DATA.menu.find(m => m.id === args.item_id);
    if (it) productIds.push(it.id);
    return it || { error: 'not_found' };
  }
  if (name === 'get_restaurant_info') return DATA.restaurant;
  if (name === 'get_current_offers') return DATA.offers;
  if (name === 'get_location') return { address: DATA.restaurant.address, maps_url: DATA.restaurant.maps_url };
  if (name === 'get_cart') return { items: cart || [] };
  return { error: 'unknown_function' };
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!ai) return { statusCode: 503, headers: HEADERS, body: JSON.stringify({ demo: true }) };

  try {
    const { message, previous_interaction_id, pending_function_result, cart } = JSON.parse(event.body || '{}');
    const productIds = [];
    let input, previousId = previous_interaction_id || undefined;

    if (pending_function_result) {
      input = [{ type: 'function_result', name: pending_function_result.name, call_id: pending_function_result.call_id,
        result: [{ type: 'text', text: JSON.stringify(pending_function_result.result) }] }];
    } else {
      if (!message || typeof message !== 'string') {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing "message".' }) };
      }
      const text = previousId ? message : `${systemPrompt()}\n\nCustomer: ${message}`;
      input = [{ type: 'user_input', content: [{ type: 'text', text }] }];
    }

    let interaction = await ai.interactions.create({ model: MODEL, input, previous_interaction_id: previousId, tools: TOOLS });

    let guard = 0;
    while (interaction.status === 'requires_action' && guard < 6) {
      guard++;
      const calls = (interaction.steps || []).filter(s => s.type === 'function_call' && !s.function_result);
      const clientCall = calls.find(c => CLIENT_FUNCS.includes(c.name));
      if (clientCall) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          needsAction: { type: clientCall.name, call_id: clientCall.id, args: clientCall.arguments },
          interactionId: interaction.id,
        }) };
      }
      const results = calls.map(c => ({
        type: 'function_result', name: c.name, call_id: c.id,
        result: [{ type: 'text', text: JSON.stringify(executeServerFunction(c.name, c.arguments, cart, productIds)) }],
      }));
      interaction = await ai.interactions.create({ model: MODEL, input: results, previous_interaction_id: interaction.id, tools: TOOLS });
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      reply: interaction.output_text, products: [...new Set(productIds)], interactionId: interaction.id,
    }) };
  } catch (err) {
    console.error('Chat function error:', err?.message || err);
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({
      error: "Sorry, I'm having trouble connecting right now. Please try again or contact our restaurant team.",
    }) };
  }
};
