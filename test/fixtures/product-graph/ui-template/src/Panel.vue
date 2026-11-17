<template>
  <section>
    <button id="refresh" @click="refresh">Refresh</button>
    <input v-on:keyup.enter="search(query)" />
    <child-list @selected="onSelected" />
  </section>
</template>

<script setup>
import { onMounted } from "vue";
onMounted(() => refresh());
function refresh() {}
function search(query) {}
function onSelected(item) {}
</script>
