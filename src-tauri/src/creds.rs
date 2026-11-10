//! The Gemini API key lives in Windows Credential Manager (a "generic"
//! credential for the current user), not in a file next to the app.

use std::ptr::null_mut;
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn save(target: &str, secret: &str) -> Result<(), String> {
    let mut target_w = wide(target);
    let mut user_w = wide("gemini-api-key");
    let mut comment_w = wide("Super Prompt Creator - Google Gemini API key");
    let blob = secret.as_bytes();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target_w.as_mut_ptr(),
        Comment: comment_w.as_mut_ptr(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: user_w.as_mut_ptr(),
        ..Default::default()
    };
    // SAFETY: every pointer in `cred` points into a buffer that outlives the call.
    let ok = unsafe { CredWriteW(&cred, 0) };
    if ok == 0 {
        Err(format!(
            "Windows Credential Manager refused to save the key: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

pub fn load(target: &str) -> Option<String> {
    let target_w = wide(target);
    let mut p: *mut CREDENTIALW = null_mut();
    // SAFETY: CredReadW allocates `p`, which we free with CredFree below.
    let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) };
    if ok == 0 || p.is_null() {
        return None;
    }
    let out = unsafe {
        let c = &*p;
        let bytes = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
        };
        String::from_utf8(bytes.to_vec()).ok()
    };
    unsafe { CredFree(p as *const core::ffi::c_void) };
    out.filter(|s| !s.is_empty())
}

pub fn delete(target: &str) {
    let target_w = wide(target);
    // SAFETY: plain call with a valid, NUL-terminated wide string.
    unsafe {
        CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0);
    }
}
