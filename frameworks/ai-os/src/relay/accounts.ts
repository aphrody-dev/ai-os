// Sync of the owner's accounts: each ACCOUNTS address is owner wherever the already authenticated CLIs
// allow it. Idempotent: only the gap is applied; `apply: false` (default) only surveys.
//   GitHub    : organizations where the gh account is admin -> email invitation, admin role (POST /orgs/{org}/invitations)
//   gcloud    : projects listed by the active account -> roles/owner for user:<address>
//   Cloudflare: accounts visible to the token -> "Super Administrator" member (API /accounts/{id}/members)
// Not automatable without the user signing in: npm (npm login), Vercel (Hobby plan: no members), OVH,
// Microsoft 365 / Outlook (no CLI session); flagged in the survey.
export const ACCOUNTS = (
  Bun.env.RELAY_OWNER_EMAILS ??
  [
    "contact@aphrody.com",
    Bun.env.APHRODY_OWNER_GOOGLE_ACCOUNT,
    Bun.env.APHRODY_AI_GOOGLE_ACCOUNT,
  ]
    .filter(Boolean)
    .join(",")
)
  .split(",")
  .map((s) => s.trim().toLowerCase());

type Step = {
  target: string;
  account: string;
  state: "present" | "missing" | "applied" | "error" | "manual";
  detail?: string;
};
const run = async (argv: string[], input?: string) => {
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: input ? new Blob([input]) : "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
};

async function github(apply: boolean): Promise<Step[]> {
  const steps: Step[] = [];
  const orgs = (
    await run([
      "gh",
      "api",
      "user/memberships/orgs",
      "-q",
      '.[]|select(.role=="admin" and .state=="active")|.organization.login',
    ])
  ).out
    .split(/\r?\n/)
    .filter(Boolean);
  for (const org of orgs) {
    // Addresses already members (public or verified email visible) or already invited.
    const invited = new Set(
      (
        await run([
          "gh",
          "api",
          `orgs/${org}/invitations`,
          "-q",
          ".[].email // empty",
        ])
      ).out
        .toLowerCase()
        .split(/\r?\n/)
        .filter(Boolean),
    );
    for (const email of ACCOUNTS) {
      const target = `github:${org}`;
      if (invited.has(email)) {
        steps.push({
          target,
          account: email,
          state: "present",
          detail: "invitation en attente",
        });
        continue;
      }
      if (!apply) {
        steps.push({ target, account: email, state: "missing" });
        continue;
      }
      const r = await run([
        "gh",
        "api",
        "-X",
        "POST",
        `orgs/${org}/invitations`,
        "-f",
        `email=${email}`,
        "-f",
        "role=admin",
      ]);
      const already =
        /already a part|is already a member|already been invited/i.test(
          r.out + r.err,
        );
      steps.push({
        target,
        account: email,
        state: r.code === 0 ? "applied" : already ? "present" : "error",
        detail:
          r.code === 0
            ? "admin invitation sent"
            : (r.out || r.err).slice(0, 200),
      });
    }
  }
  return steps;
}

async function gcloud(apply: boolean): Promise<Step[]> {
  const steps: Step[] = [];
  const projects = (
    await run(["gcloud", "projects", "list", "--format=value(projectId)"])
  ).out
    .split(/\r?\n/)
    .filter(Boolean);
  const scope = (Bun.env.RELAY_GCP_PROJECTS ?? "").split(",").filter(Boolean);
  for (const p of scope.length
    ? projects.filter((x) => scope.includes(x))
    : projects) {
    const owners = new Set(
      (
        await run([
          "gcloud",
          "projects",
          "get-iam-policy",
          p,
          "--flatten=bindings[].members",
          "--filter=bindings.role:roles/owner",
          "--format=value(bindings.members)",
        ])
      ).out
        .toLowerCase()
        .split(/\r?\n/),
    );
    for (const email of ACCOUNTS) {
      const target = `gcloud:${p}`;
      if (owners.has(`user:${email}`)) {
        steps.push({ target, account: email, state: "present" });
        continue;
      }
      if (!apply) {
        steps.push({ target, account: email, state: "missing" });
        continue;
      }
      const r = await run([
        "gcloud",
        "projects",
        "add-iam-policy-binding",
        p,
        `--member=user:${email}`,
        "--role=roles/owner",
        "--condition=None",
        "--quiet",
        "--format=none",
      ]);
      // Project outside an organization: Google requires an owner invitation through the console (SOLO_MUST_INVITE_OWNERS).
      const invite = /SOLO_MUST_INVITE_OWNERS/.test(r.err + r.out);
      steps.push({
        target,
        account: email,
        state: r.code === 0 ? "applied" : invite ? "manual" : "error",
        detail:
          r.code === 0
            ? "roles/owner"
            : invite
              ? `owner invitation through the console: https://console.cloud.google.com/iam-admin/iam?project=${p}`
              : r.err.split(/\r?\n/).at(-1)?.slice(0, 240),
      });
    }
  }
  return steps;
}

async function cloudflare(apply: boolean): Promise<Step[]> {
  const token = Bun.env.CLOUDFLARE_API_TOKEN;
  if (!token)
    return [
      {
        target: "cloudflare",
        account: "*",
        state: "manual",
        detail:
          "CLOUDFLARE_API_TOKEN missing (Account Members:Edit permission required)",
      },
    ];
  const cf = async (path: string, init?: RequestInit) =>
    (
      await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      })
    ).json() as Promise<any>;
  const steps: Step[] = [];
  for (const acc of (await cf("/accounts")).result ?? []) {
    const members = await cf(`/accounts/${acc.id}/members?per_page=50`);
    if (!members.success) {
      steps.push({
        target: `cloudflare:${acc.name}`,
        account: "*",
        state: "manual",
        detail: members.errors?.[0]?.message ?? "member listing refused",
      });
      continue;
    }
    const have = new Set(
      (members.result ?? []).map((m: any) =>
        String(m.user?.email ?? "").toLowerCase(),
      ),
    );
    const roles = (await cf(`/accounts/${acc.id}/roles`)).result ?? [];
    const superAdmin = roles.find((r: any) =>
      /Super Administrator/i.test(r.name),
    )?.id;
    for (const email of ACCOUNTS) {
      const target = `cloudflare:${acc.name}`;
      if (have.has(email)) {
        steps.push({ target, account: email, state: "present" });
        continue;
      }
      if (!apply || !superAdmin) {
        steps.push({
          target,
          account: email,
          state: "missing",
          detail: superAdmin ? undefined : "Super Administrator role not found",
        });
        continue;
      }
      const r = await cf(`/accounts/${acc.id}/members`, {
        method: "POST",
        body: JSON.stringify({ email, roles: [superAdmin], status: "pending" }),
      });
      steps.push({
        target,
        account: email,
        state: r.success ? "applied" : "error",
        detail: r.success
          ? "invitation Super Administrator"
          : r.errors?.[0]?.message,
      });
    }
  }
  return steps;
}

export async function accountsSync(apply = false) {
  const steps = [
    ...(await github(apply)),
    ...(await gcloud(apply)),
    ...(await cloudflare(apply)),
  ];
  steps.push(
    {
      target: "npm",
      account: "*",
      state: "manual",
      detail:
        "npm login then npm org set <org> <user> owner (npm addresses users, not emails)",
    },
    {
      target: "vercel",
      account: "*",
      state: "manual",
      detail: "aphrody-dev team on the Hobby plan: no members",
    },
    {
      target: "ovh / microsoft-365 / outlook",
      account: "*",
      state: "manual",
      detail: "no CLI session: user sign-in required",
    },
  );
  return { apply, accounts: ACCOUNTS, steps };
}
