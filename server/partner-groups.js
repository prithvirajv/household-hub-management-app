// Partners groups: a space shared by e-mail between the partners who own rental properties together. It holds the Partners page's setup (properties,
// partners, ownership, rules, per-row choices) and the shared account's rows, and it belongs to no household: each member signs in to their own
// FamilyLoop, keeps their own household for their own home, and sees the group beside it. Roles: owner (everything, including who has access),
// edit (change the setup, import rows) and view (read only). Membership is matched on the signed-in person's verified e-mail address.
const { partnersSanitizeConfig, partnersMergeCsvRows, partnersMergeBankRows, PARTNERS_POOL_ID } = require("../lib/partners-logic");

const MAX_ROWS = 20000;
const MAX_ROWS_PER_REQUEST = 6000;
const ROLES = ["owner", "edit", "view"];

const clientError = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;

// ---- storage: one interface, in memory (tests, demo) or Postgres ----
function createGroupStore({ MEMORY_DB, memoryDb, pool }) {
  if (MEMORY_DB) {
    memoryDb.partnerGroups ||= [];
    const find = (id) => memoryDb.partnerGroups.find((group) => group.id === id) || null;
    const view = (group) => group && ({ id: group.id, name: group.name, ownerUserId: group.ownerUserId, setup: group.setup, rows: group.rows, poolBalance: group.poolBalance, version: group.version });
    let counter = 0;
    return {
      async create({ name, ownerUserId, ownerEmail, setup, rows, poolBalance }) {
        const group = { id: `pg-${Date.now().toString(36)}-${++counter}`, name, ownerUserId, setup, rows, poolBalance: poolBalance || null, version: 1, members: [{ id: `pgm-${Date.now().toString(36)}-${++counter}`, email: ownerEmail, role: "owner" }] };
        memoryDb.partnerGroups.push(group);
        return view(group);
      },
      async get(id) { return view(find(id)); },
      async membershipsFor(email) { return memoryDb.partnerGroups.flatMap((group) => group.members.filter((member) => member.email === email).map((member) => ({ groupId: group.id, role: member.role }))); },
      async ownedBy(userId) { return memoryDb.partnerGroups.filter((group) => group.ownerUserId === userId).map((group) => group.id); },
      async members(id) { return (find(id)?.members || []).map((member) => ({ ...member })); },
      async upsertMember(id, email, role) {
        const group = find(id);
        const existing = group.members.find((member) => member.email === email);
        if (existing) { if (existing.role !== "owner") existing.role = role; return { ...existing }; }
        const member = { id: `pgm-${Date.now().toString(36)}-${++counter}`, email, role };
        group.members.push(member);
        return { ...member };
      },
      async setMemberRole(id, memberId, role) { const member = find(id)?.members.find((item) => item.id === memberId); if (member && member.role !== "owner") member.role = role; return Boolean(member); },
      async removeMember(id, memberId) { const group = find(id); const before = group.members.length; group.members = group.members.filter((member) => member.id !== memberId || member.role === "owner"); return group.members.length < before; },
      async saveSetup(id, setup, expectedVersion) {
        const group = find(id);
        if (expectedVersion !== null && Number(expectedVersion) !== group.version) return { conflict: true, version: group.version };
        group.setup = setup; group.version += 1;
        return { version: group.version };
      },
      async saveRows(id, rows, poolBalance) { const group = find(id); group.rows = rows; if (poolBalance !== undefined) group.poolBalance = poolBalance; return true; },
      async rename(id, name) { find(id).name = name; return true; },
      async remove(id) { memoryDb.partnerGroups = memoryDb.partnerGroups.filter((group) => group.id !== id); return true; }
    };
  }
  const view = (row) => row && ({ id: row.id, name: row.name, ownerUserId: row.owner_user_id, setup: row.setup || {}, rows: row.tx_rows || [], poolBalance: row.pool_balance || null, version: row.version });
  return {
    async create({ name, ownerUserId, ownerEmail, setup, rows, poolBalance }) {
      const created = await pool.query("INSERT INTO partner_groups (name, owner_user_id, setup, tx_rows, pool_balance) VALUES ($1, $2, $3, $4, $5) RETURNING *", [name, ownerUserId, setup, JSON.stringify(rows), poolBalance ? JSON.stringify(poolBalance) : null]);
      await pool.query("INSERT INTO partner_group_members (group_id, email, role, invited_by) VALUES ($1, $2, 'owner', $3)", [created.rows[0].id, ownerEmail, ownerUserId]);
      return view(created.rows[0]);
    },
    async get(id) { return view((await pool.query("SELECT * FROM partner_groups WHERE id::text = $1", [id])).rows[0]); },
    async membershipsFor(email) { return (await pool.query("SELECT group_id, role FROM partner_group_members WHERE email = $1", [email])).rows.map((row) => ({ groupId: row.group_id, role: row.role })); },
    async ownedBy(userId) { return (await pool.query("SELECT id FROM partner_groups WHERE owner_user_id = $1", [userId])).rows.map((row) => row.id); },
    async members(id) { return (await pool.query("SELECT id, email, role FROM partner_group_members WHERE group_id::text = $1 ORDER BY (role = 'owner') DESC, created_at", [id])).rows; },
    async upsertMember(id, email, role, invitedBy) {
      const result = await pool.query(
        `INSERT INTO partner_group_members (group_id, email, role, invited_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_id, email) DO UPDATE SET role = CASE WHEN partner_group_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END
         RETURNING id, email, role`, [id, email, role, invitedBy]);
      return result.rows[0];
    },
    async setMemberRole(id, memberId, role) { return (await pool.query("UPDATE partner_group_members SET role = $3 WHERE group_id::text = $1 AND id::text = $2 AND role <> 'owner'", [id, memberId, role])).rowCount > 0; },
    async removeMember(id, memberId) { return (await pool.query("DELETE FROM partner_group_members WHERE group_id::text = $1 AND id::text = $2 AND role <> 'owner'", [id, memberId])).rowCount > 0; },
    async saveSetup(id, setup, expectedVersion) {
      const result = await pool.query("UPDATE partner_groups SET setup = $2, version = version + 1, updated_at = now() WHERE id::text = $1 AND ($3::int IS NULL OR version = $3::int) RETURNING version", [id, setup, expectedVersion]);
      if (result.rowCount) return { version: result.rows[0].version };
      return { conflict: true, version: (await pool.query("SELECT version FROM partner_groups WHERE id::text = $1", [id])).rows[0]?.version };
    },
    async saveRows(id, rows, poolBalance) {
      await pool.query("UPDATE partner_groups SET tx_rows = $2, pool_balance = COALESCE($3::jsonb, pool_balance), updated_at = now() WHERE id::text = $1", [id, JSON.stringify(rows), poolBalance === undefined || poolBalance === null ? null : JSON.stringify(poolBalance)]);
      return true;
    },
    async rename(id, name) { await pool.query("UPDATE partner_groups SET name = $2, updated_at = now() WHERE id::text = $1", [id, name]); return true; },
    async remove(id) { await pool.query("DELETE FROM partner_groups WHERE id::text = $1", [id]); return true; }
  };
}

// What a set of rows from a request may contain: a real date, a finite non-zero amount, a short payee.
function cleanRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS_PER_REQUEST).map((row) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(row && row.date)) ? String(row.date) : "",
    payee: String((row && row.payee) || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200),
    amount: Number(row && row.amount),
    externalId: String((row && row.externalId) || "").slice(0, 200),
    source: row && row.source === "csv" ? "csv" : (row && row.source === "bank" ? "bank" : "")
  })).filter((row) => row.date && Number.isFinite(row.amount) && row.amount !== 0 && Math.abs(row.amount) < 1e9);
}

function cleanBalance(balance) {
  if (!balance || !Number.isFinite(Number(balance.amount))) return null;
  return { amount: Number(balance.amount), date: /^\d{4}-\d{2}-\d{2}$/.test(String(balance.date)) ? String(balance.date) : "", name: String(balance.name || "").slice(0, 120) };
}

function registerPartnerGroupRoutes({ app, requireSession, sendTransactionalEmail, appBaseUrl, escapeHtml, MEMORY_DB, memoryDb, pool, env = process.env }) {
  const store = createGroupStore({ MEMORY_DB, memoryDb, pool });
  // A person is matched to a group by e-mail, so the address has to be one they have proved is theirs. (Tests may relax this.)
  const requireVerified = String(env.PARTNER_GROUPS_ALLOW_UNVERIFIED_EMAIL || "") !== "true";
  const emailOf = (user) => normalizeEmail(user.email);
  const verified = (user) => !requireVerified || Boolean(user.email_verified_at);
  const wrap = (handler) => async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  };

  // The caller's role in a group, or null: the owner by user id, anyone else by verified e-mail.
  const roleIn = async (user, group) => {
    if (!group) return null;
    if (group.ownerUserId && group.ownerUserId === user.id) return "owner";
    if (!verified(user)) return null;
    const mine = (await store.members(group.id)).find((member) => member.email === emailOf(user));
    return mine ? mine.role : null;
  };
  const loadGroup = async (req, { need = "view" } = {}) => {
    const group = await store.get(String(req.params.id));
    const role = await roleIn(req.sessionUser, group);
    if (!role) throw clientError("Partners group not found", 404);
    const rank = { view: 1, edit: 2, owner: 3 };
    if (rank[role] < rank[need]) throw clientError(need === "owner" ? "Only the group's owner can do that" : "You have view-only access to this group", 403);
    return { group, role };
  };
  const detail = async (group, role, user) => {
    const members = await store.members(group.id);
    return {
      id: group.id, name: group.name, role, version: group.version, setup: group.setup, rows: group.rows, poolBalance: group.poolBalance,
      members: members.map((member) => ({ id: member.id, email: member.email, role: member.role, isYou: member.email === emailOf(user) || (member.role === "owner" && group.ownerUserId === user.id) }))
    };
  };

  app.get("/api/partner-groups", requireSession, wrap(async (req, res) => {
    const user = req.sessionUser;
    const ids = new Set(await store.ownedBy(user.id));
    const memberships = await store.membershipsFor(emailOf(user));
    const groups = [];
    const waiting = [];
    for (const membership of memberships) {
      if (ids.has(membership.groupId)) continue;
      const group = await store.get(String(membership.groupId));
      if (!group) continue;
      if (verified(user)) { ids.add(group.id); } else waiting.push({ id: group.id, name: group.name });
    }
    for (const id of ids) {
      const group = await store.get(String(id));
      const role = await roleIn(user, group);
      if (group && role) groups.push({ id: group.id, name: group.name, role });
    }
    res.json({ groups, waitingForVerification: waiting, emailVerified: Boolean(user.email_verified_at) });
  }));

  app.post("/api/partner-groups", requireSession, wrap(async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (!name) throw clientError("Give the group a name", 400);
    const setup = partnersSanitizeConfig(req.body?.setup || {});
    setup.accountIds = [];
    // Starting from a household's existing Partners rows keeps each row as it was (CSV rows stay CSV rows, so a later bank row can adopt them).
    const rows = cleanRows(req.body?.rows).map((row) => ({ ...row, source: row.source || (row.externalId ? "bank" : "csv") }));
    const group = await store.create({ name, ownerUserId: req.sessionUser.id, ownerEmail: emailOf(req.sessionUser), setup, rows, poolBalance: cleanBalance(req.body?.poolBalance) });
    res.status(201).json(await detail(group, "owner", req.sessionUser));
  }));

  app.get("/api/partner-groups/:id", requireSession, wrap(async (req, res) => {
    const { group, role } = await loadGroup(req);
    res.json(await detail(group, role, req.sessionUser));
  }));

  app.patch("/api/partner-groups/:id", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "owner" });
    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (!name) throw clientError("Give the group a name", 400);
    await store.rename(group.id, name);
    res.json({ ok: true, name });
  }));

  app.delete("/api/partner-groups/:id", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "owner" });
    await store.remove(group.id);
    res.json({ ok: true });
  }));

  app.put("/api/partner-groups/:id/setup", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "edit" });
    const setup = partnersSanitizeConfig(req.body?.setup || {});
    setup.accountIds = [];
    const version = req.body?.version === undefined || req.body?.version === null ? null : Number(req.body.version);
    const result = await store.saveSetup(group.id, setup, version);
    if (result.conflict) return res.status(409).json({ error: "Someone else changed this group a moment ago, so it was reloaded - repeat your change.", version: result.version });
    res.json({ ok: true, version: result.version, setup });
  }));

  // Rows: mode "csv" (a statement the person imported: only what is not already here is added) or "bank" (rows from a bank link, which carry the
  // bank's ids). Either way nothing is ever added twice.
  app.post("/api/partner-groups/:id/rows", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "edit" });
    const incoming = cleanRows(req.body?.rows);
    if (!incoming.length) throw clientError("No transactions to add", 400);
    const merged = req.body?.mode === "bank" ? partnersMergeBankRows(group.rows, incoming) : partnersMergeCsvRows(group.rows, incoming);
    if (merged.rows.length > MAX_ROWS) throw clientError(`A group keeps at most ${MAX_ROWS} transactions`, 413);
    await store.saveRows(group.id, merged.rows, req.body?.poolBalance === undefined ? undefined : cleanBalance(req.body.poolBalance));
    res.json({ ok: true, added: merged.added, skipped: merged.skipped ?? (incoming.length - merged.added), total: merged.rows.length });
  }));

  app.delete("/api/partner-groups/:id/rows", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "owner" });
    await store.saveRows(group.id, [], undefined);
    res.json({ ok: true });
  }));

  app.post("/api/partner-groups/:id/members", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "owner" });
    const email = normalizeEmail(req.body?.email);
    const role = String(req.body?.role || "edit");
    if (!looksLikeEmail(email)) throw clientError("Enter a valid email address", 400);
    if (!["edit", "view"].includes(role)) throw clientError("Role must be 'edit' or 'view'", 400);
    if (email === emailOf(req.sessionUser)) throw clientError("You already own this group", 400);
    const member = await store.upsertMember(group.id, email, role, req.sessionUser.id);
    let emailed = false;
    try {
      const url = `${appBaseUrl}/index.html?email=${encodeURIComponent(email)}`;
      const title = `${req.sessionUser.name || "A partner"} added you to "${group.name}" on FamilyLoop`;
      await sendTransactionalEmail({
        to: email, subject: title,
        text: `${title}.\n\nYou can ${role === "edit" ? "view and edit" : "view"} the partnership's properties, rent, loans and contributions. Sign in (or create an account with this email address, and verify it) at ${url} and open Partners.\n\nYou keep your own FamilyLoop household for your own home; this group is separate from it.`,
        html: `<h2>${escapeHtml(title)}</h2><p>You can ${role === "edit" ? "view and edit" : "view"} the partnership's properties, rent, loans and contributions.</p><p><a href="${escapeHtml(url)}">Sign in or create an account</a> with this email address, verify it, then open <b>Partners</b>.</p><p>You keep your own FamilyLoop household for your own home; this group is separate from it.</p>`
      });
      emailed = true;
    } catch (error) { console.warn(`Partners group invite email failed: ${error.message}`); }
    res.status(201).json({ ok: true, member: { id: member.id, email: member.email, role: member.role }, emailed });
  }));

  app.patch("/api/partner-groups/:id/members/:memberId", requireSession, wrap(async (req, res) => {
    const { group } = await loadGroup(req, { need: "owner" });
    const role = String(req.body?.role || "");
    if (!["edit", "view"].includes(role)) throw clientError("Role must be 'edit' or 'view'", 400);
    if (!(await store.setMemberRole(group.id, String(req.params.memberId), role))) throw clientError("Member not found", 404);
    res.json({ ok: true });
  }));

  // The owner removes anyone; anyone else may remove only themselves (leave the group).
  app.delete("/api/partner-groups/:id/members/:memberId", requireSession, wrap(async (req, res) => {
    const { group, role } = await loadGroup(req);
    const target = (await store.members(group.id)).find((member) => String(member.id) === String(req.params.memberId));
    if (!target) throw clientError("Member not found", 404);
    if (role !== "owner" && target.email !== emailOf(req.sessionUser)) throw clientError("Only the group's owner can remove someone else", 403);
    if (target.role === "owner") throw clientError("The owner cannot be removed", 400);
    await store.removeMember(group.id, target.id);
    res.json({ ok: true });
  }));

  return { store };
}

// The overnight bank sync forwards what it fetched for the account kept for the Partners page into the group the household is linked to. It checks
// that the household's owner owns that group, so a household can never write into someone else's group. Returns true when the rows landed.
async function forwardHouseholdPartnerRows(store, { groupId, householdOwnerId, rows, poolBalance }) {
  if (!groupId || !householdOwnerId) return false;
  const group = await store.get(String(groupId));
  if (!group || group.ownerUserId !== householdOwnerId) return false;
  const incoming = cleanRows(rows);
  const merged = incoming.length ? partnersMergeBankRows(group.rows, incoming) : { rows: group.rows, added: 0 };
  if (merged.rows.length > MAX_ROWS) return false;
  await store.saveRows(group.id, merged.rows, cleanBalance(poolBalance) || undefined);
  return true;
}

module.exports = { registerPartnerGroupRoutes, createGroupStore, forwardHouseholdPartnerRows, PARTNERS_POOL_ID, ROLES };
