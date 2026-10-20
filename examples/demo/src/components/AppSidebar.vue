<script setup>
const items = ["Overview", "Projects", "Deployments", "Analytics", "Billing", "Settings"];
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="logo">N</span>
      <span>Northwind</span>
    </div>
    <nav>
      <a v-for="item in items" :key="item" href="#" :class="{ active: item === 'Billing' }">{{ item }}</a>
    </nav>
    <div class="account">
      <span class="avatar">JD</span>
      <div>
        <strong>Jordan Diaz</strong>
        <small>jordan@northwind.dev</small>
      </div>
    </div>
  </aside>
</template>
