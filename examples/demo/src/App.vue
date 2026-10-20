<script setup>
import AppSidebar from "./components/AppSidebar.vue";
import PlanCard from "./components/PlanCard.vue";
import TeamTable from "./components/TeamTable.vue";
import UsageChart from "./components/UsageChart.vue";
</script>

<template>
  <div class="shell">
    <AppSidebar />
    <main class="content">
      <header class="page-header">
        <div>
          <p class="eyebrow">Settings</p>
          <h1>Billing</h1>
        </div>
        <button class="btn btn-ghost" data-testid="invoices">Download invoices</button>
      </header>
      <div class="grid">
        <PlanCard />
        <UsageChart />
      </div>
      <TeamTable />
    </main>
  </div>
</template>
