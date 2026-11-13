<script setup>
const time = useState("time", () => new Date().toISOString());
</script>

<template>
  <main>
    <h1>hello-nuxt: rendered on the server</h1>
    <p>server time: {{ time }}</p>
    <NuxtLink to="/about">About</NuxtLink>
  </main>
</template>
