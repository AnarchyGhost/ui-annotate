<script setup>
defineProps({ title: String });
</script>

<template>
  <section class="card">
    <h2>{{ title }}</h2>
    <p data-testid="card-text">Card text with some words to select</p>
  </section>
</template>
