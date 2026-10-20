<script setup>
const features = ["Unlimited projects", "50 GB bandwidth", "Preview deployments", "Email support"];
</script>

<template>
  <section class="card plan">
    <div class="card-head">
      <h2>Current plan</h2>
      <span class="badge">Monthly</span>
    </div>
    <p class="price"><strong>$24</strong> / month</p>
    <p class="muted">Pro plan, renews on November 14</p>
    <ul class="features">
      <li v-for="feature in features" :key="feature">{{ feature }}</li>
    </ul>
    <div class="actions">
      <button class="btn btn-secondary" data-testid="upgrade">Upgrade plan</button>
      <button class="btn btn-link" data-testid="cancel">Cancel subscription</button>
    </div>
  </section>
</template>
