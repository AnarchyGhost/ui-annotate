<script setup>
import AppToolbar from "./components/AppToolbar.vue";
import InfoCard from "./components/InfoCard.vue";
</script>

<template>
  <main class="layout">
    <AppToolbar />
    <InfoCard title="Card title" />
    <p data-testid="plain-text">Plain text in App</p>
  </main>
</template>
