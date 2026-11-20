export async function compressImageFile(
  file: File,
  maxDimension = 720,
  maxChars = 220000
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please select a valid image file (PNG, JPG, or WebP).');
  }

  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not decode the selected image.'));
      image.src = bitmapUrl;
    });

    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas compression is unavailable in this browser.');
    }
    ctx.drawImage(img, 0, 0, width, height);

    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/webp', quality);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    while (dataUrl.length > maxChars && quality > 0.35) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    if (dataUrl.length > maxChars) {
      throw new Error('Image is still too large after compression. Please pick a smaller image.');
    }

    return dataUrl;
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

export async function readAssignmentFile(
  file: File,
  maxChars = 330000
): Promise<{ fileName: string; fileType: string; fileData: string }> {
  if (file.type.startsWith('image/')) {
    const compressed = await compressImageFile(file, 960, maxChars);
    return {
      fileName: file.name.slice(0, 180),
      fileType: 'image/jpeg',
      fileData: compressed,
    };
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });

  if (dataUrl.length > maxChars) {
    throw new Error(
      'File exceeds the 240 KB free-tier attachment limit. Please upload a smaller PDF/document or a compressed photo.'
    );
  }

  return {
    fileName: file.name.slice(0, 180),
    fileType: (file.type || 'application/octet-stream').slice(0, 90),
    fileData: dataUrl,
  };
}

export async function svgToCompressedDataUrl(
  svgMarkup: string,
  maxChars = 120000
): Promise<string> {
  const sanitized = svgMarkup
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  const svgBlob = new Blob([sanitized], { type: 'image/svg+xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to render generated diagram.'));
      image.src = blobUrl;
    });

    const width = 880;
    const height = 540;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas rendering is unavailable in this browser.');
    }

    ctx.fillStyle = '#FAF9F6';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    let quality = 0.88;
    let dataUrl = canvas.toDataURL('image/webp', quality);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    while (dataUrl.length > maxChars && quality > 0.35) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    if (dataUrl.length > maxChars) {
      throw new Error('Generated visual exceeded storage limit. Please try again.');
    }

    return dataUrl;
  } catch {
    const fallbackUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`;
    if (fallbackUrl.length <= maxChars) {
      return fallbackUrl;
    }
    throw new Error('Could not convert AI diagram into an image. Please try again.');
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
