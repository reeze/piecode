
async function getLatestRustVersion() {
  try {
    const response = await fetch('https://api.github.com/repos/rust-lang/rust/releases/latest');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.tag_name; // 版本号通常是如 "1.75.0" 这样的格式
  } catch (error) {
    console.error('获取Rust最新版本失败:', error);
    return null;
  }
}

// 测试函数
getLatestRustVersion().then(version => {
  if (version) {
    console.log('Rust最新版本:', version);
  } else {
    console.log('无法获取Rust最新版本');
  }
});
