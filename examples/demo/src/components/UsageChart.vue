<script setup>
const days = [
  { label: "Mon", value: 42 },
  { label: "Tue", value: 64 },
  { label: "Wed", value: 51 },
  { label: "Thu", value: 88 },
  { label: "Fri", value: 73 },
  { label: "Sat", value: 30 },
  { label: "Sun", value: 24 },
];
</script>

<template>
  <section class="card usage">
    <div class="card-head">
      <h2>Bandwidth this week</h2>
      <span class="muted">31.6 of 50 GB</span>
    </div>
    <div class="bars" data-testid="usage-bars">
      <div v-for="day in days" :key="day.label" class="bar-col">
        <div class="bar" :style="{ height: `${day.value}%` }" />
        <span>{{ day.label }}</span>
      </div>
    </div>
  </section>
</template>
