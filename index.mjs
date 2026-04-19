import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = process.env.PORT || 8080;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

if (!AUTH_USER || !AUTH_PASS) {
  console.error('AUTH_USER and AUTH_PASS environment variables are required');
  process.exit(1);
}

const RAVELRY_BASE = 'https://api.ravelry.com';
const authHeader = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
let cachedUsername = null;

async function get(path) {
  const res = await fetch(`${RAVELRY_BASE}${path}`, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ravelry ${res.status} on ${path}${errText ? ` — ${errText.slice(0, 500)}` : ''}`);
  }
  return res.json();
}

async function post(path, body = {}) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) form.append(`${k}[]`, String(item));
    } else if (typeof v === 'boolean') {
      form.set(k, v ? '1' : '0');
    } else {
      form.set(k, String(v));
    }
  }
  const res = await fetch(`${RAVELRY_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ravelry ${res.status} on ${path}${errText ? ` — ${errText.slice(0, 500)}` : ''}`);
  }
  return res.json();
}

async function del(path) {
  const res = await fetch(`${RAVELRY_BASE}${path}`, { method: 'DELETE', headers: { Authorization: authHeader } });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ravelry ${res.status} on ${path}${errText ? ` — ${errText.slice(0, 500)}` : ''}`);
  }
  return res.json();
}

async function getUsername() {
  if (cachedUsername) return cachedUsername;
  const data = await get('/current_user.json');
  cachedUsername = data.user.username;
  return cachedUsername;
}

function text(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: 'Ravelry', version: '2.0.3' });

  // ACCOUNT
  server.tool('get_current_user', 'Get the current authenticated user profile', {}, async () =>
    text(await get('/current_user.json')));

  server.tool('get_person', 'Get any Ravelry user profile by username', {
    username: z.string()
  }, async ({ username }) => text(await get(`/people/${username}.json`)));

  // QUEUE
  server.tool('queue_list', 'List your queued projects', {
    query: z.string().optional(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(50)
  }, async ({ query, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (query) p.set('query', query);
    return text(await get(`/people/${u}/queue/list.json?${p}`));
  });

  server.tool('queue_show', 'Get details for a single queued project', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await get(`/people/${u}/queue/${id}.json`));
  });

  server.tool('queue_order', 'Get full ordered list of queue positions', {}, async () => {
    const u = await getUsername();
    return text(await get(`/people/${u}/queue/order.json`));
  });

  server.tool('queue_add', 'Add a pattern to your queue', {
    pattern_id: z.number().optional().describe('Ravelry pattern ID'),
    personal_pattern_name: z.string().optional().describe('Name if not linking to a Ravelry pattern'),
    sort_order: z.number().optional().describe('Position (1 = top)'),
    yarn_id: z.number().optional(),
    notes: z.string().optional(),
    make_for: z.string().optional(),
    start_on: z.string().optional().describe('YYYY-MM-DD'),
    finish_by: z.string().optional().describe('YYYY-MM-DD'),
    skeins: z.number().optional()
  }, async (params) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/queue/create.json`, params));
  });

  server.tool('queue_update', 'Update a queued project', {
    id: z.number(),
    notes: z.string().optional(),
    yarn_id: z.number().optional(),
    make_for: z.string().optional(),
    start_on: z.string().optional().describe('YYYY-MM-DD'),
    finish_by: z.string().optional().describe('YYYY-MM-DD'),
    skeins: z.number().optional()
  }, async ({ id, ...data }) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/queue/${id}/update.json`, data));
  });

  server.tool('queue_remove', 'DESTRUCTIVE — permanently delete a queued project', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await del(`/people/${u}/queue/${id}.json`));
  });

  server.tool('queue_reposition', 'Move a queued project to a new position', {
    id: z.number(),
    insert_at: z.number().describe('New position (1 = top)')
  }, async ({ id, insert_at }) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/queue/${id}/reposition.json`, { insert_at }));
  });

  // STASH
  server.tool('stash_list', 'List your yarn stash', {
    sort: z.enum(['alpha', 'recent', 'weight', 'colorfamily', 'yards']).optional().default('alpha'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(50)
  }, async ({ sort, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ sort, page: String(page), page_size: String(page_size) });
    return text(await get(`/people/${u}/stash/list.json?${p}`));
  });

  server.tool('stash_show', 'Get details for a single stash entry', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await get(`/people/${u}/stash/${id}.json`));
  });

  server.tool('stash_unified', 'Get combined yarn and fiber stash', {
    sort: z.enum(['alpha', 'recent', 'weight', 'colorfamily', 'grams']).optional().default('alpha'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(50)
  }, async ({ sort, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ sort, page: String(page), page_size: String(page_size) });
    return text(await get(`/people/${u}/stash/unified/list.json?${p}`));
  });

  server.tool('stash_add', 'Add a yarn to your stash', {
    yarn_id: z.number().optional().describe('Ravelry yarn ID'),
    colorway: z.string().optional(),
    dye_lot: z.string().optional(),
    location: z.string().optional().describe('Where the yarn is stored'),
    notes: z.string().optional(),
    stash_status_id: z.number().optional().describe('1=active 2=used up 3=will trade/sell 4=gone/sold'),
    tag_list: z.string().optional().describe('Space-delimited tags')
  }, async (params) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/stash/create.json`, params));
  });

  server.tool('stash_update', 'Update a stash entry', {
    id: z.number(),
    location: z.string().optional(),
    notes: z.string().optional(),
    stash_status_id: z.number().optional().describe('1=active 2=used up 3=will trade/sell 4=gone/sold'),
    tag_list: z.string().optional()
  }, async ({ id, ...data }) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/stash/${id}.json`, data));
  });

  server.tool('stash_remove', 'DESTRUCTIVE — permanently delete a stash entry', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await del(`/people/${u}/stash/${id}.json`));
  });

  // PROJECTS
  server.tool('projects_list', 'List your projects', {
    sort: z.string().optional().describe('status, name, created, started, favorites, happiness'),
    page: z.number().optional().default(1),
    page_size: z.number().optional()
  }, async ({ sort, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ page: String(page) });
    if (sort) p.set('sort', sort);
    if (page_size) p.set('page_size', String(page_size));
    return text(await get(`/projects/${u}/list.json?${p}`));
  });

  server.tool('project_show', 'Get full details for a single project', {
    id: z.union([z.number(), z.string()]).describe('Project ID or permalink')
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await get(`/projects/${u}/${id}.json`));
  });

  server.tool('projects_search', 'Search all public projects on Ravelry', {
    query: z.string(),
    sort: z.string().optional().describe('best, started, completed, favorites, helpful, updated, happiness'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ query, sort, page, page_size }) => {
    const p = new URLSearchParams({ query, page: String(page), page_size: String(page_size) });
    if (sort) p.set('sort', sort);
    return text(await get(`/projects/search.json?${p}`));
  });

  server.tool('project_create', 'Create a new project', {
    name: z.string(),
    pattern_id: z.number().optional(),
    personal_pattern_name: z.string().optional(),
    started: z.string().optional().describe('YYYY-MM-DD'),
    completed: z.string().optional().describe('YYYY-MM-DD'),
    progress: z.number().optional().describe('0-100'),
    project_status_id: z.number().optional(),
    notes: z.string().optional(),
    size: z.string().optional(),
    made_for: z.string().optional(),
    tag_names: z.array(z.string()).optional()
  }, async (data) => {
    const u = await getUsername();
    return text(await post(`/projects/${u}/create.json`, data));
  });

  server.tool('project_update', 'Update a project', {
    id: z.union([z.number(), z.string()]),
    name: z.string().optional(),
    started: z.string().optional().describe('YYYY-MM-DD'),
    completed: z.string().optional().describe('YYYY-MM-DD'),
    progress: z.number().optional().describe('0-100'),
    project_status_id: z.number().optional(),
    notes: z.string().optional(),
    rating: z.number().optional().describe('1-5'),
    tag_names: z.array(z.string()).optional()
  }, async ({ id, ...data }) => {
    const u = await getUsername();
    return text(await post(`/projects/${u}/${id}.json`, data));
  });

  server.tool('project_delete', 'DESTRUCTIVE — permanently delete a project', {
    id: z.union([z.number(), z.string()])
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await del(`/projects/${u}/${id}.json`));
  });

  // FAVORITES
  server.tool('favorites_list', 'List your favorites', {
    types: z.string().optional().describe('Space-delimited: project pattern yarn stash forumpost designer yarnbrand yarnshop bundle'),
    query: z.string().optional(),
    tag: z.string().optional(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ types, query, tag, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (types) p.set('types', types);
    if (query) p.set('query', query);
    if (tag) p.set('tag', tag);
    return text(await get(`/people/${u}/favorites/list.json?${p}`));
  });

  server.tool('favorite_show', 'Get a single favorite record', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await get(`/people/${u}/favorites/${id}.json`));
  });

  server.tool('favorite_add', 'Add something to your favorites', {
    type: z.enum(['project', 'pattern', 'yarn', 'stash', 'forumpost', 'designer', 'yarnbrand', 'yarnshop']),
    favorited_id: z.number().describe('ID of the item to favorite'),
    comment: z.string().optional(),
    tag_list: z.string().optional()
  }, async (data) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/favorites/create.json`, data));
  });

  server.tool('favorite_update', 'Update a favorite comment or tags', {
    id: z.number(),
    comment: z.string().optional(),
    tag_list: z.string().optional()
  }, async ({ id, ...data }) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/favorites/${id}.json`, data));
  });

  server.tool('favorite_remove', 'DESTRUCTIVE — delete a favorite', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await del(`/people/${u}/favorites/${id}.json`));
  });

  // LIBRARY
  server.tool('library_search', 'Search your pattern library (PDFs, books, magazines)', {
    query: z.string().optional(),
    type: z.string().optional().describe('book, magazine, booklet, pattern, pdf'),
    sort: z.string().optional().describe('title, added, published, author'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(100)
  }, async ({ query, type, sort, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (query) p.set('query', query);
    if (type) p.set('type', type);
    if (sort) p.set('sort', sort);
    return text(await get(`/people/${u}/library/search.json?${p}`));
  });

  server.tool('library_add', 'Add a pattern or source to your library', {
    pattern_id: z.number().optional(),
    pattern_source_id: z.number().optional(),
    notes: z.string().optional()
  }, async (data) => text(await post('/volumes/create.json', data)));

  server.tool('library_remove', 'DESTRUCTIVE — remove a volume from your library', {
    volume_id: z.number()
  }, async ({ volume_id }) => text(await del(`/volumes/${volume_id}.json`)));

  // NEEDLES
  server.tool('needles_list', 'List your needle and hook inventory', {}, async () => {
    const u = await getUsername();
    return text(await get(`/people/${u}/needles/list.json`));
  });

  server.tool('needle_sizes', 'Get available needle and hook sizes', {
    craft: z.enum(['knitting', 'crochet']).optional()
  }, async ({ craft }) => {
    const p = new URLSearchParams();
    if (craft) p.set('craft', craft);
    return text(await get(`/needles/sizes.json?${p}`));
  });

  server.tool('needle_types', 'Get needle types (circulars, DPNs, straights, hooks)', {}, async () =>
    text(await get('/needles/types.json')));

  // BUNDLES
  server.tool('bundles_list', 'List your bundles', {
    query: z.string().optional(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ query, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (query) p.set('query', query);
    return text(await get(`/people/${u}/bundles/list.json?${p}`));
  });

  server.tool('bundle_show', 'Get a single bundle with its contents', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await get(`/people/${u}/bundles/${id}.json`));
  });

  server.tool('bundle_create', 'Create a new bundle', {
    name: z.string(),
    notes: z.string().optional()
  }, async (data) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/bundles/create.json`, data));
  });

  server.tool('bundle_update', 'Update a bundle', {
    id: z.number(),
    name: z.string().optional(),
    notes: z.string().optional()
  }, async ({ id, ...data }) => {
    const u = await getUsername();
    return text(await post(`/people/${u}/bundles/${id}.json`, data));
  });

  server.tool('bundle_delete', 'DESTRUCTIVE — delete a bundle', {
    id: z.number()
  }, async ({ id }) => {
    const u = await getUsername();
    return text(await del(`/people/${u}/bundles/${id}.json`));
  });

  // PATTERNS
  server.tool('search_patterns', 'Search the Ravelry pattern database', {
    query: z.string().optional(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25),
    craft: z.enum(['knitting', 'crochet']).optional(),
    availability: z.enum(['free', 'ravelry', 'online']).optional(),
    weight: z.string().optional().describe('fingering, sport, dk, worsted, bulky, etc.'),
    fit: z.string().optional().describe('adult, baby, child, etc.'),
    sort: z.string().optional().describe('best, popularity, rating, recently-popular, date'),
    personal_attributes: z.boolean().optional().describe('Include queued/favorited status for current user')
  }, async ({ query, page, page_size, craft, availability, weight, fit, sort, personal_attributes }) => {
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (query) p.set('query', query);
    if (craft) p.set('craft', craft);
    if (availability) p.set('availability', availability);
    if (weight) p.set('weight', weight);
    if (fit) p.set('fit', fit);
    if (sort) p.set('sort', sort);
    if (personal_attributes) p.set('personal_attributes', '1');
    return text(await get(`/patterns/search.json?${p}`));
  });

  server.tool('get_pattern', 'Get full details for a single pattern by ID', {
    id: z.number()
  }, async ({ id }) => text(await get(`/patterns/${id}.json`)));

  server.tool('get_patterns', 'Get details for multiple patterns at once', {
    ids: z.array(z.number())
  }, async ({ ids }) => text(await get(`/patterns.json?ids=${ids.join('+')}`)));

  server.tool('pattern_highlights', 'Get pattern highlights curated for your account', {
    days: z.number().optional().default(30).describe('Days of highlights (max 90)')
  }, async ({ days }) => text(await get(`/patterns/highlights.json?days=${days}`)));

  server.tool('pattern_projects', 'Get projects linked to a specific pattern', {
    id: z.number().describe('Pattern ID'),
    sort: z.string().optional().describe('favorites, completed'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ id, sort, page, page_size }) => {
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (sort) p.set('sort', sort);
    return text(await get(`/patterns/${id}/projects.json?${p}`));
  });

  // YARNS
  server.tool('search_yarns', 'Search the Ravelry yarn database', {
    query: z.string(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25),
    sort: z.string().optional().describe('best, rating, projects'),
    weight: z.string().optional(),
    personal_attributes: z.boolean().optional()
  }, async ({ query, page, page_size, sort, weight, personal_attributes }) => {
    const p = new URLSearchParams({ query, page: String(page), page_size: String(page_size) });
    if (sort) p.set('sort', sort);
    if (weight) p.set('weight', weight);
    if (personal_attributes) p.set('personal_attributes', '1');
    return text(await get(`/yarns/search.json?${p}`));
  });

  server.tool('get_yarn', 'Get full details for a yarn including colorways', {
    id: z.number()
  }, async ({ id }) => text(await get(`/yarns/${id}.json?include=colorways`)));

  server.tool('get_yarns', 'Get details for multiple yarns at once', {
    ids: z.array(z.number())
  }, async ({ ids }) => text(await get(`/yarns.json?ids=${ids.join('+')}`)));

  server.tool('search_yarn_companies', 'Search the yarn brand directory', {
    query: z.string(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ query, page, page_size }) => {
    const p = new URLSearchParams({ query, page: String(page), page_size: String(page_size) });
    return text(await get(`/yarn_companies/search.json?${p}`));
  });

  // DESIGNERS + SOURCES
  server.tool('get_designer', 'Get a designer profile and pattern info', {
    id: z.union([z.number(), z.string()]).describe('Designer ID or permalink')
  }, async ({ id }) => text(await get(`/designers/${id}.json?include=featured_bundles`)));

  server.tool('search_pattern_sources', 'Search books, magazines, and pattern sources', {
    query: z.string().describe('Title, author, or ISBN'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ query, page, page_size }) => {
    const p = new URLSearchParams({ query, page: String(page), page_size: String(page_size) });
    return text(await get(`/pattern_sources/search.json?${p}`));
  });

  server.tool('get_pattern_source', 'Get details for a pattern source (book, magazine, etc.)', {
    id: z.number()
  }, async ({ id }) => text(await get(`/pattern_sources/${id}.json`)));

  // SHOPS
  server.tool('search_shops', 'Search yarn shops by location or keyword', {
    query: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    radius: z.number().optional(),
    units: z.enum(['miles', 'km']).optional(),
    shop_type_id: z.number().optional().describe('1 = local yarn stores only'),
    page: z.number().optional().default(1)
  }, async ({ query, lat, lng, radius, units, shop_type_id, page }) => {
    const p = new URLSearchParams({ page: String(page) });
    if (query) p.set('query', query);
    if (lat) p.set('lat', String(lat));
    if (lng) p.set('lng', String(lng));
    if (radius) p.set('radius', String(radius));
    if (units) p.set('units', units);
    if (shop_type_id) p.set('shop_type_id', String(shop_type_id));
    return text(await get(`/shops/search.json?${p}`));
  });

  server.tool('get_shop', 'Get details for a yarn shop', {
    id: z.number()
  }, async ({ id }) => text(await get(`/shops/${id}.json?include=brands+ad+schedules`)));

  // SOCIAL + COMMS
  server.tool('friends_list', 'Get your friend list', {}, async () => {
    const u = await getUsername();
    return text(await get(`/people/${u}/friends/list.json`));
  });

  server.tool('friends_activity', 'Get recent activity from friends', {
    activity_types: z.string().optional().describe('Space-delimited: added-project-photo added-stash-photo queued-pattern added-favorite'),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ activity_types, page, page_size }) => {
    const u = await getUsername();
    const p = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (activity_types) p.set('activity_type_keys', activity_types);
    return text(await get(`/people/${u}/friends/activity.json?${p}`));
  });

  server.tool('messages_list', 'List your messages', {
    folder: z.enum(['inbox', 'sent', 'archived']).default('inbox'),
    unread_only: z.boolean().optional(),
    page: z.number().optional().default(1),
    page_size: z.number().optional().default(25)
  }, async ({ folder, unread_only, page, page_size }) => {
    const p = new URLSearchParams({ folder, page: String(page), page_size: String(page_size) });
    if (unread_only) p.set('unread_only', '1');
    return text(await get(`/messages/list.json?${p}`));
  });

  server.tool('message_show', 'Get a single message', {
    id: z.number()
  }, async ({ id }) => text(await get(`/messages/${id}.json`)));

  server.tool('message_send', 'Send a message to another Ravelry user', {
    recipient_username: z.string(),
    subject: z.string(),
    content: z.string().describe('Markdown supported')
  }, async (data) => text(await post('/messages/create.json', data)));

  server.tool('message_reply', 'Reply to a message', {
    id: z.number().describe('Message ID to reply to'),
    subject: z.string(),
    content: z.string()
  }, async ({ id, ...data }) => text(await post(`/messages/${id}/reply.json`, data)));

  server.tool('message_mark_read', 'Mark a message as read', {
    id: z.number()
  }, async ({ id }) => text(await post(`/messages/${id}/mark_read.json`)));

  server.tool('message_archive', 'Archive a message (move to saved)', {
    id: z.number()
  }, async ({ id }) => text(await post(`/messages/${id}/archive.json`)));

  server.tool('message_delete', 'DESTRUCTIVE — permanently delete a message', {
    id: z.number()
  }, async ({ id }) => text(await del(`/messages/${id}.json`)));

  server.tool('comment_create', 'Post a comment on a pattern, project, yarn, or stash entry', {
    type: z.enum(['project', 'pattern', 'yarn', 'stash']),
    commented_id: z.number().describe('ID of the item'),
    body: z.string().describe('Markdown supported')
  }, async (data) => text(await post('/comments/create.json', data)));

  server.tool('comment_delete', 'DESTRUCTIVE — delete a comment', {
    id: z.number()
  }, async ({ id }) => text(await del(`/comments/${id}.json`)));

  // REFERENCE DATA
  server.tool('get_color_families', 'Get all Ravelry color families', {}, async () =>
    text(await get('/color_families.json')));

  server.tool('get_yarn_weights', 'Get all yarn weight categories', {}, async () =>
    text(await get('/yarn_weights.json')));

  server.tool('get_pattern_categories', 'Get all pattern categories', {}, async () =>
    text(await get('/pattern_categories/list.json')));

  server.tool('global_search', 'Search across all Ravelry content types at once', {
    query: z.string(),
    types: z.string().optional().describe('Space-delimited: User PatternAuthor PatternSource Pattern YarnCompany Yarn Group Project Page Topic Shop'),
    limit: z.number().optional().default(50)
  }, async ({ query, types, limit }) => {
    const p = new URLSearchParams({ query, limit: String(limit) });
    if (types) p.set('types', types);
    return text(await get(`/search.json?${p}`));
  });

  return server;
}

const app = express();
app.use(express.json());

// Stateless Streamable HTTP — each request creates its own transport + server
// This avoids session-ID tracking issues with clients that don't manage sessions
app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined  // stateless
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[ravelry-mcp] handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error', data: String(err?.message || err) },
        id: null
      });
    }
  }
});

// GET and DELETE on /mcp are for session-based transports — return method not allowed in stateless mode
app.get('/mcp', (req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed (stateless server)' },
  id: null
}));

app.delete('/mcp', (req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed (stateless server)' },
  id: null
}));

app.get('/health', (req, res) => res.json({ status: 'ok', tools: 'full', version: '2.0.3' }));

app.listen(PORT, () => {
  console.log(`[ravelry-mcp] v2.0.3 Running on port ${PORT}`);
  console.log(`[ravelry-mcp] MCP (Streamable HTTP, stateless): POST http://localhost:${PORT}/mcp`);
  console.log(`[ravelry-mcp] Health: GET http://localhost:${PORT}/health`);
});
