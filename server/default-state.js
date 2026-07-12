const defaultState = {
  household: {
    name: "Carter Household",
    country: "US",
    currency: "USD",
    inviteCode: "",
    members: [
      { name: "Alex", role: "Owner", email: "demo@familyloop.net" },
      { name: "Alex Carter", role: "Co-owner - Invited", email: "alex@example.com" }
    ],
    sharedScopes: [
      "Budget",
      "Transactions",
      "Bank sync",
      "Paychecks",
      "Calendar",
      "Chores",
      "Birthday reminders",
      "Notes",
      "Meals",
      "Grocery lists",
      "Reminders",
      "Goals",
      "Debt payoff",
      "Net worth",
      "Reports"
    ],
    activity: [
      "Alex Carter was invited to the complete household workspace",
      "Grocery plan posted to budget",
      "Birthday reminder added"
    ]
  },
  budget: {
    month: "2026-05",
    income: 5200,
    categories: [
      {
        name: "Giving",
        color: "#d7961f",
        lines: [
          { id: "church-charity", name: "Church and charity", planned: 520, dueDay: 12 }
        ]
      },
      {
        name: "Housing",
        color: "#2563eb",
        lines: [
          { id: "rent", name: "Rent", planned: 1850, dueDay: 1 },
          { id: "power-water", name: "Utilities", planned: 240, dueDay: 18 },
          { id: "internet", name: "Internet", planned: 80, dueDay: 21 }
        ]
      },
      {
        name: "Debt",
        color: "#e35d5b",
        lines: [
          { id: "credit-card", name: "Credit card payoff", planned: 620, dueDay: 12 }
        ]
      },
      {
        name: "Food",
        color: "#16a34a",
        lines: [
          { id: "groceries", name: "Groceries", planned: 360, dueDay: 7 },
          { id: "restaurants", name: "Restaurants", planned: 160, dueDay: 15 }
        ]
      },
      {
        name: "Transportation",
        color: "#ef4444",
        lines: [
          { id: "fuel", name: "Fuel", planned: 160, dueDay: 30 },
          { id: "auto-maintenance", name: "Auto maintenance", planned: 160, dueDay: 28 }
        ]
      },
      {
        name: "Savings and debt",
        color: "#7c8b2e",
        lines: [
          { id: "starter-emergency", name: "Starter emergency fund", planned: 350, dueDay: 30 },
          { id: "vacation", name: "Vacation sinking fund", planned: 250, dueDay: 28 },
          { id: "debt-extra", name: "Debt snowball", planned: 450, dueDay: 28 }
        ]
      }
    ]
  },
  budgetHistory: [
    {
      month: "2026-04",
      income: 5200,
      categories: [
        {
          name: "Giving",
          color: "#d7961f",
          lines: [
            { id: "church-charity", name: "Church and charity", planned: 520, dueDay: 12 }
          ]
        },
        {
          name: "Housing",
          color: "#2563eb",
          lines: [
            { id: "rent", name: "Rent", planned: 1850, dueDay: 1 },
            { id: "power-water", name: "Utilities", planned: 235, dueDay: 18 },
            { id: "internet", name: "Internet", planned: 80, dueDay: 21 }
          ]
        },
        {
          name: "Food",
          color: "#16a34a",
          lines: [
            { id: "groceries", name: "Groceries", planned: 400, dueDay: 7 },
            { id: "restaurants", name: "Restaurants", planned: 140, dueDay: 15 }
          ]
        },
        {
          name: "Transportation",
          color: "#ef4444",
          lines: [
            { id: "fuel", name: "Fuel", planned: 150, dueDay: 30 },
            { id: "auto-maintenance", name: "Auto maintenance", planned: 125, dueDay: 28 }
          ]
        },
        {
          name: "Savings and debt",
          color: "#7c8b2e",
          lines: [
            { id: "starter-emergency", name: "Starter emergency fund", planned: 300, dueDay: 30 },
            { id: "vacation", name: "Vacation sinking fund", planned: 200, dueDay: 28 },
            { id: "debt-extra", name: "Debt snowball", planned: 350, dueDay: 28 }
          ]
        }
      ]
    },
    {
      month: "2026-03",
      income: 5000,
      categories: [
        {
          name: "Housing",
          color: "#2563eb",
          lines: [
            { id: "rent", name: "Rent", planned: 1850, dueDay: 1 },
            { id: "utilities", name: "Utilities", planned: 220, dueDay: 18 },
            { id: "internet", name: "Internet", planned: 80, dueDay: 21 }
          ]
        },
        {
          name: "Food",
          color: "#16a34a",
          lines: [
            { id: "groceries", name: "Groceries", planned: 380, dueDay: 7 },
            { id: "restaurants", name: "Restaurants", planned: 120, dueDay: 15 }
          ]
        },
        {
          name: "Debt",
          color: "#e35d5b",
          lines: [
            { id: "credit-card", name: "Credit card payoff", planned: 500, dueDay: 12 }
          ]
        }
      ]
    }
  ],
  transactions: [
    { date: "2026-05-01", payee: "Lakeside Apartments", lineId: "rent", amount: 1850, memo: "May rent" },
    { date: "2026-05-03", payee: "Green Market", lineId: "groceries", amount: 96.80, memo: "Groceries" },
    { date: "2026-05-05", payee: "Card Services", lineId: "credit-card", amount: 620, memo: "Debt payoff" },
    { date: "2026-05-08", payee: "The Noodle Room", lineId: "restaurants", amount: 68.40, memo: "Dinner" },
    { date: "2026-05-09", payee: "Fuel Stop", lineId: "fuel", amount: 52.60, memo: "Gas" },
    { date: "2026-05-10", payee: "Corner Market", lineId: "groceries", amount: 86.00, memo: "Groceries" },
    { date: "2026-05-12", payee: "Coffee House", lineId: "church-charity", amount: 18.72, memo: "Split example" },
    { date: "2026-05-12", payee: "Bookstore", lineId: "church-charity", amount: 42.10, memo: "Split example" },
    { date: "2026-05-17", payee: "Power and Water", lineId: "power-water", amount: 211.38, memo: "Utilities" }
  ],
  paychecks: [
    { date: "2026-05-03", name: "May 3 paycheck", amount: 2600, assignedLineIds: ["rent", "church-charity", "fuel"] },
    { date: "2026-05-17", name: "May 17 paycheck", amount: 2600, assignedLineIds: ["power-water", "credit-card", "starter-emergency", "vacation"] }
  ],
  calendar: {
    events: [
      { date: "2026-05-04", title: "Soccer practice", type: "event" },
      { date: "2026-05-12", title: "Credit card payoff due", type: "reminder" },
      { date: "2026-05-28", monthDay: "05-28", title: "Mimi birthday", type: "birthday", annual: true, reminderDays: 7 },
      { date: "2026-05-31", monthDay: "05-31", title: "Sam Carter's birthday", type: "birthday", annual: true, reminderDays: 7 },
      { date: "2026-06-14", monthDay: "06-14", title: "Wedding anniversary", type: "anniversary", annual: true, reminderDays: 7 }
    ],
    chores: [
      { title: "Clean kitchen", assignee: "Alex", cadence: "Weekly", recurrence: "weekly", startDate: "2026-05-23", nextDue: "2026-05-23", completedDates: [] },
      { title: "Take out trash", assignee: "Taylor", cadence: "Weekly", recurrence: "weekly", startDate: "2026-05-30", nextDue: "2026-05-30", completedDates: [] },
      { title: "Fold laundry", assignee: "Rotation", cadence: "Weekly", recurrence: "weekly", startDate: "2026-05-31", nextDue: "2026-05-31", completedDates: [] }
    ]
  },
  notes: {
    initialized: true,
    activeView: "notes",
    activeLabel: "",
    labels: ["Birthday", "House warming", "Groceries"],
    entries: [
      {
        id: "weekend-todo",
        title: "Weekend ToDo",
        body: "",
        checklist: [
          { id: "weekend-1", text: "Organize the garage", done: false },
          { id: "weekend-2", text: "Confirm dinner plans", done: false },
          { id: "weekend-3", text: "Buy birthday card", done: true }
        ],
        labels: ["House warming"],
        pinned: true,
        archived: false,
        trashed: false,
        color: "#fff7d6",
        createdAt: "2026-05-21T12:00:00.000Z"
      },
      {
        id: "grocery-stops",
        title: "Grocery stops",
        body: "",
        checklist: [
          { id: "grocery-1", text: "Milk", done: false },
          { id: "grocery-2", text: "Marinara sauce", done: false },
          { id: "grocery-3", text: "Grapes", done: false },
          { id: "grocery-4", text: "Bread", done: true }
        ],
        labels: ["Groceries"],
        pinned: false,
        archived: false,
        trashed: false,
        color: "#ffffff",
        createdAt: "2026-05-20T12:00:00.000Z"
      },
      {
        id: "birthday-ideas",
        title: "Birthday ideas",
        body: "Call the bakery and confirm the guest list.",
        checklist: [],
        labels: ["Birthday"],
        pinned: false,
        archived: false,
        trashed: false,
        color: "#eef7ff",
        createdAt: "2026-05-19T12:00:00.000Z"
      }
    ]
  },
  decisions: [
    {
      id: "decision-bigger-apartment",
      title: "Should we move to a bigger apartment?",
      notes: "Current lease is up in August.",
      status: "open",
      outcome: "",
      decidedAt: "",
      pros: [
        { id: "pro-1", text: "More space for the kids", authorKey: "demo@familyloop.net", authorName: "Alex" },
        { id: "pro-2", text: "Closer to school", authorKey: "alex@example.com", authorName: "Alex Carter" }
      ],
      cons: [
        { id: "con-1", text: "Higher rent", authorKey: "demo@familyloop.net", authorName: "Alex" }
      ],
      createdAt: "2026-05-15T12:00:00.000Z"
    }
  ],
  meals: {
    nutritionGoals: { calories: 2100, protein: 140 },
    selectedWeekByMonth: { "2026-05": 1 },
    plannedWeek: [
      { month: "2026-05", week: 1, day: "Monday", meal: "Turkey chili", recipeId: "turkey-chili", servings: 4 },
      { month: "2026-05", week: 1, day: "Tuesday", meal: "Salmon bowls", recipeId: "salmon-bowls", servings: 2 },
      { month: "2026-05", week: 1, day: "Wednesday", meal: "Pasta primavera", recipeId: "pasta-primavera", servings: 4 },
      { month: "2026-05", week: 1, day: "Thursday", meal: "Sheet-pan chicken", recipeId: "sheet-pan-chicken", servings: 4 },
      { month: "2026-05", week: 1, day: "Friday", meal: "Pizza night", recipeId: "pizza-night", servings: 3 }
    ],
    recipes: [
      { id: "turkey-chili", name: "Turkey chili", ingredients: ["ground turkey", "beans", "tomatoes", "onion"], calories: 520, protein: 38 },
      { id: "salmon-bowls", name: "Salmon bowls", ingredients: ["salmon", "rice", "cucumber", "avocado"], calories: 610, protein: 42 },
      { id: "pasta-primavera", name: "Pasta primavera", ingredients: ["pasta", "zucchini", "peas", "parmesan"], calories: 560, protein: 24 },
      { id: "sheet-pan-chicken", name: "Sheet-pan chicken", ingredients: ["chicken", "potatoes", "broccoli", "lemon"], calories: 590, protein: 46 },
      { id: "pizza-night", name: "Pizza night", ingredients: ["pizza dough", "mozzarella", "sauce", "salad greens"], calories: 700, protein: 30 }
    ],
    savedWeeks: ["Spring reset", "High protein week"]
  },
  goals: {
    sinkingFunds: [
      { name: "Starter emergency fund", target: 1000, saved: 650, targetDate: "2026-12-31" },
      { name: "Vacation fund", target: 2500, saved: 900, targetDate: "2026-11-15" },
      { name: "Auto repair buffer", target: 1200, saved: 420, targetDate: "2026-09-01" }
    ],
    debts: [
      { name: "Credit card", balance: 8200, rate: 18.9, minimum: 220, termMonths: 60, payments: [] },
      { name: "Car loan", balance: 7800, rate: 5.9, minimum: 310, termMonths: 30, payments: [] }
    ],
    netWorth: {
      assets: [
        { id: "checking", name: "Checking", value: 2380, assetClass: "cash" },
        { name: "Emergency savings", value: 650, assetClass: "cash" },
        { name: "401(k)", value: 18500, assetClass: "retirement" }
      ],
      liabilities: [
        { id: "credit-card", name: "Credit card", value: 4280 },
        { name: "Car loan", value: 7600 },
        { name: "Student loan", value: 11850 }
      ]
    }
  },
  accounts: [
    { id: "checking-account", name: "Checking", type: "checking", openingBalance: 2380, netWorthAssetId: "checking", netWorthLiabilityId: "", createdAt: "2026-05-01" },
    { id: "credit-card-account", name: "Credit card", type: "credit_card", openingBalance: 4280, netWorthAssetId: "", netWorthLiabilityId: "credit-card", createdAt: "2026-05-01" }
  ],
  transfers: []
};

module.exports = { defaultState };
